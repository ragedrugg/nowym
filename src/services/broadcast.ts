/** Админ-рассылка: одно сообщение любого типа (bot.api.copyMessage — не разбираем
 * контент по типам) всем chat_id из known_chats. Состояние на одного админа
 * (ADMIN_USER_ID один, не список), поэтому простая Map, а не полноценный
 * @gramio/dialogs FSM. */

import type { Bot } from "gramio";
import { bold, code as codeFmt, type FormattableString, format } from "gramio";
import { floodRetry } from "../infra/floodRetry.ts";
import { getLogger } from "../infra/logging.ts";
import { AsyncTokenGate } from "../infra/rateLimit.ts";
import { Semaphore } from "../infra/semaphore.ts";
import type { KnownChatsDb } from "../storage/knownChats.ts";
import { formatEta, renderProgressBar } from "./albums.ts";

const log = getLogger("services.broadcast");

// черновик рассылки, забытый на полпути (админ передумал/отвлёкся), не должен
// висеть вечно и ловить случайное будущее сообщение админа.
const COMPOSE_TTL_MS = 600_000; // 10 мин

// Telegram держит общий лимит ~30 msg/s на бота, идём с запасом.
const SEND_CONCURRENCY = 5;
const RATE_BURST = 10;
const RATE_REFILL_MS = 50; // ~20 msg/s с запасом от лимита телеграма

type Stage = "awaiting_content" | "confirm" | "sending";
interface BroadcastState {
  stage: Stage;
  createdAt: number;
  fromChatId?: number;
  messageId?: number;
  cancelled?: boolean;
}

export interface BroadcastResult {
  total: number;
  sent: number;
  failed: number;
  blocked: number;
}

/** true — получатель недоступен навсегда (блок/деактивация/чат исчез), чистим из known_chats.
 * false — временный сбой (сеть, 5xx), просто считаем как failed и не трогаем список. */
function isUnreachable(e: unknown): boolean {
  const codeNum = (e as { code?: number })?.code;
  if (codeNum === 403) return true; // Forbidden: бот заблокирован/кикнут
  const msg = String((e as Error)?.message ?? e).toLowerCase();
  return msg.includes("chat not found") || msg.includes("user is deactivated") || msg.includes("bot was blocked");
}

export class BroadcastService {
  private state = new Map<number, BroadcastState>();

  constructor(
    private knownChatsDb: KnownChatsDb,
    private bot: Bot,
  ) {}

  private getFresh(adminId: number): BroadcastState | null {
    const s = this.state.get(adminId);
    if (!s) return null;
    if (Date.now() - s.createdAt > COMPOSE_TTL_MS) {
      this.state.delete(adminId);
      return null;
    }
    return s;
  }

  /** /broadcast — начинаем ждать сообщение-содержимое. */
  startCompose(adminId: number): void {
    this.state.set(adminId, { stage: "awaiting_content", createdAt: Date.now() });
  }

  isAwaitingContent(adminId: number): boolean {
    return this.getFresh(adminId)?.stage === "awaiting_content";
  }

  /** админ прислал сообщение, которое нужно разослать — фиксируем ссылку на него. */
  captureContent(adminId: number, fromChatId: number, messageId: number): boolean {
    const s = this.getFresh(adminId);
    if (!s || s.stage !== "awaiting_content") return false;
    this.state.set(adminId, { stage: "confirm", createdAt: Date.now(), fromChatId, messageId });
    return true;
  }

  /** confirm/cancel-кнопки читают, что именно подтверждают. */
  pendingConfirm(adminId: number): { fromChatId: number; messageId: number } | null {
    const s = this.getFresh(adminId);
    if (!s || s.stage !== "confirm" || s.fromChatId === undefined || s.messageId === undefined) return null;
    return { fromChatId: s.fromChatId, messageId: s.messageId };
  }

  /** отмена черновика (до старта отправки). */
  cancelCompose(adminId: number): boolean {
    const s = this.getFresh(adminId);
    if (!s || s.stage === "sending") return false;
    this.state.delete(adminId);
    return true;
  }

  /** confirm нажат — переводим в sending, отдаём захваченное сообщение. Атомарно
   * относительно повторного тапа: второй вызов увидит stage !== "confirm" и получит null. */
  beginSending(adminId: number): { fromChatId: number; messageId: number } | null {
    const pending = this.pendingConfirm(adminId);
    if (!pending) return null;
    this.state.set(adminId, { stage: "sending", createdAt: Date.now(), ...pending, cancelled: false });
    return pending;
  }

  /** кнопка «остановить» во время отправки. */
  requestStop(adminId: number): boolean {
    const s = this.state.get(adminId);
    if (!s || s.stage !== "sending") return false;
    s.cancelled = true;
    return true;
  }

  private isCancelled(adminId: number): boolean {
    return this.state.get(adminId)?.cancelled === true;
  }

  /** сама рассылка. onProgress зовётся не чаще раза в 1.5с — не заваливаем
   * editMessageText на сотнях получателей. */
  async run(
    adminId: number,
    fromChatId: number,
    messageId: number,
    onProgress: (r: BroadcastResult) => Promise<void>,
  ): Promise<BroadcastResult> {
    const chatIds = await this.knownChatsDb.allChatIds();
    const total = chatIds.length;
    const result: BroadcastResult = { total, sent: 0, failed: 0, blocked: 0 };

    const gate = new AsyncTokenGate(RATE_BURST, RATE_REFILL_MS);
    const sem = new Semaphore(SEND_CONCURRENCY);
    let lastRender = 0;

    const sendOne = async (chatId: number): Promise<void> => {
      await gate.acquire();
      if (this.isCancelled(adminId)) return;
      try {
        await floodRetry(
          () => this.bot.api.copyMessage({ chat_id: chatId, from_chat_id: fromChatId, message_id: messageId }),
          { attempts: 5, graceMs: 200 },
        );
        result.sent += 1;
      } catch (e) {
        if (isUnreachable(e)) {
          result.blocked += 1;
          void this.knownChatsDb.remove(chatId).catch((re) => log.debug(`[broadcast] remove(${chatId}): ${re}`));
        } else {
          result.failed += 1;
          log.debug(`[broadcast] chat=${chatId}: ${e}`);
        }
      }
      const done = result.sent + result.failed + result.blocked;
      const now = performance.now();
      if (now - lastRender > 1500 || done === total) {
        lastRender = now;
        await onProgress({ ...result });
      }
    };

    await Promise.allSettled(
      chatIds.map((chatId) => sem.run(() => (this.isCancelled(adminId) ? Promise.resolve() : sendOne(chatId)))),
    );

    this.state.delete(adminId);
    return result;
  }
}

/** прогресс-сообщение рассылки, без разбивки по трекам. */
export function broadcastProgressText(r: BroadcastResult, elapsedSec: number): FormattableString {
  const done = r.sent + r.failed + r.blocked;
  const bar = renderProgressBar(done, r.total);
  let eta = "";
  if (done > 0 && done < r.total) eta = `, осталось ~${formatEta((elapsedSec / done) * (r.total - done))}`;
  const tail = done < r.total ? eta : `, за ${formatEta(elapsedSec)}`;
  return format`📨 ${bold("рассылка")}
${codeFmt(bar)} ${done}/${r.total}${tail}
✅ ${r.sent} · ❌ ${r.failed} · 🚫 заблокировали ${r.blocked}`;
}
