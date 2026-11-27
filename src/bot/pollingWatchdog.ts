/** Сторож long-polling (только режим BOT_API_BASE_URL; webhook не трогает).
 *
 * Фиксирует завершение каждого getUpdates (успех или ошибка — цикл жив) через
 * onApiCall-хук gramio. Если ни один getUpdates не завершился дольше stallMs:
 *  1) висящий запрос обрывается ошибкой PollingStalledError — цикл gramio ловит её,
 *     логирует и через retryGetUpdatesWait шлёт новый getUpdates (рестарт in-process
 *     без bot.stop(): тот навсегда выключает очередь апдейтов, а stop/start при
 *     висящем fetch оставил бы второй живой цикл);
 *  2) если и после этого за stallMs ни одного завершения (или висит не getUpdates) —
 *     onFatal: процесс выходит с ненулевым кодом, pm2 поднимает заново.
 * Если рвать нечего (запроса нет: gramio спит между попытками — retryGetUpdatesWait
 * или 429 retry_after в withRetries), сначала даётся одно окно stallMs на
 * восстановление, а известный retry_after из ответа 429 сдвигает порог целиком.
 * Heartbeat засчитывается только от текущего запроса (токен на вызов): поздний
 * ответ оборванного запроса не маскирует зависание нового.
 * Один setInterval на весь процесс. */
import { getLogger } from "../infra/logging.ts";

const log = getLogger("bot.polling_watchdog");

export class PollingStalledError extends Error {
  constructor(idleMs: number) {
    super(`getUpdates не завершался ${Math.round(idleMs / 1000)}s — оборван сторожем`);
    this.name = "PollingStalledError";
  }
}

export interface PollingWatchdogOptions {
  /** сколько можно жить без завершённого getUpdates, мс. */
  stallMs: number;
  /** период проверки, мс (по умолчанию 10с). */
  checkEveryMs?: number;
  /** in-process восстановление не помогло — вызывающий завершает процесс. */
  onFatal: (reason: string) => void;
}

export class PollingWatchdog {
  private readonly stallMs: number;
  private readonly checkEveryMs: number;
  private readonly onFatal: (reason: string) => void;
  /** момент последнего завершения (может быть в будущем: + известный retry_after). */
  private lastBeat = Date.now();
  /** момент открытия окна восстановления; null — окна с последнего завершения не было. */
  private interruptedAt: number | null = null;
  /** чем открыто окно: обрывом висящего запроса или простоем без запроса. */
  private recovery: "interrupt" | "idle" | null = null;
  private interruptPending: ((e: Error) => void) | null = null;
  /** токен текущего getUpdates; 0 — текущего нет (не начат или оборван). */
  private currentToken = 0;
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(o: PollingWatchdogOptions) {
    this.stallMs = o.stallMs;
    this.checkEveryMs = o.checkEveryMs ?? 10_000;
    this.onFatal = o.onFatal;
  }

  /** onApiCall-хук для getUpdates: `bot.onApiCall("getUpdates", watchdog.hook)`. */
  readonly hook = (_ctx: unknown, next: () => Promise<unknown>): Promise<unknown> => {
    const token = ++this.seq;
    this.currentToken = token;
    const call = next().then(
      (v) => {
        this.beat(token, v); // suppress-вызовы возвращают TelegramError значением
        return v;
      },
      (e: unknown) => {
        this.beat(token, e);
        throw e;
      },
    );
    let interrupt!: (e: Error) => void;
    const interrupted = new Promise<never>((_, reject) => {
      interrupt = reject;
    });
    this.interruptPending = interrupt;
    return Promise.race([call, interrupted]).finally(() => {
      if (this.interruptPending === interrupt) this.interruptPending = null;
    });
  };

  start(): void {
    if (this.timer) return;
    this.lastBeat = Date.now();
    this.timer = setInterval(() => this.check(), this.checkEveryMs);
    this.timer.unref?.();
    log.info(`[watchdog] запущен: порог ${Math.round(this.stallMs / 1000)}s без завершённого getUpdates`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private beat(token: number, outcome: unknown): void {
    if (token !== this.currentToken) return; // поздний ответ оборванного/устаревшего запроса
    const retryAfterSec = (outcome as { payload?: { retry_after?: unknown } } | null)?.payload?.retry_after;
    const retryAfterMs = typeof retryAfterSec === "number" && retryAfterSec > 0 ? retryAfterSec * 1000 : 0;
    // gramio проспит retry_after до следующего getUpdates — это не зависание
    this.lastBeat = Date.now() + retryAfterMs;
    if (this.interruptedAt !== null) {
      log.info("[watchdog] getUpdates снова завершается — polling восстановлен");
      this.interruptedAt = null;
      this.recovery = null;
    }
  }

  private check(): void {
    const now = Date.now();
    const idle = now - this.lastBeat;
    if (idle <= this.stallMs) return;
    if (this.recovery !== "interrupt" && this.interruptPending) {
      log.warning(
        `[watchdog] getUpdates не завершался ${Math.round(idle / 1000)}s — обрываю запрос, polling продолжится`,
      );
      const interrupt = this.interruptPending;
      this.interruptPending = null;
      this.currentToken = 0;
      this.interruptedAt = now;
      this.recovery = "interrupt";
      this.lastBeat = now; // новое окно stallMs на восстановление
      interrupt(new PollingStalledError(idle));
      return;
    }
    if (this.recovery === null) {
      log.warning(
        `[watchdog] нет завершённого getUpdates ${Math.round(idle / 1000)}s и нет активного запроса ` +
          "(gramio ждёт перед повтором?) — даю окно на восстановление",
      );
      this.interruptedAt = now;
      this.recovery = "idle";
      this.lastBeat = now;
      return;
    }
    this.stop();
    const total = Math.round((now - (this.interruptedAt ?? now) + this.stallMs) / 1000);
    const reason =
      this.recovery === "idle"
        ? `нет завершённого getUpdates ${total}s и нет активного запроса`
        : `после обрыва getUpdates ${Math.round(idle / 1000)}s без завершённого запроса`;
    log.error(`[watchdog] polling завис: ${reason} — выход для рестарта`);
    this.onFatal(reason);
  }
}
