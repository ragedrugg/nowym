/** Сборка yaebal-бота: диалоги, мидлвари, хендлеры, onError. Без сети и таймеров —
 * main.ts решает, как его гнать (runner/webhook), а smoke-скрипт и тесты собирают
 * тот же бот против фейкового Bot API. */
import type { DialogState } from "@yaebal/morda";
import { Bot, type StorageAdapter, TelegramError } from "yaebal";
import { getLogger } from "../infra/logging.ts";
import { incCounter } from "../infra/metrics.ts";
import type { Container } from "./container.ts";
import { createMenuDialogs, dialogAnswerGate } from "./dialogs.ts";
import { registerHandlers } from "./handlers/index.ts";
import { mordaRetry } from "./mordaRetry.ts";
import type { AppBot } from "./types.ts";

const log = getLogger("bot.app");

/** GramIO-конвенция baseURL `…/bot` → голый origin, который ждёт yaebal (`apiRoot`);
 * пусто — облачный api.telegram.org. */
export function apiRootOf(baseUrl: string): string | undefined {
  const root = baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/bot$/, "");
  return root || undefined;
}

/** потолок апдейтов в работе у @yaebal/runner. GramIO-очередь потолка не имела, а хендлеры
 * nowym держат слот минутами (chosen_inline_result качает трек, ссылка на альбом ждёт всю
 * выгрузку): на пороге раннер перестаёт звать getUpdates (бот «замирает»; сторож это видит
 * по счётчику апдейтов в работе и не считает зависанием). Реальная нагрузка ограничена лимитерами и очередью
 * скачиваний, поэтому потолок — с большим запасом, только от взрывного роста. */
export const RUNNER_CONCURRENCY = 512;

/** allowed_updates: только типы, на которые есть хендлеры (registerHandlers + morda). Полный
 * список Bot API (updateNames) гнал бы лишние апдейты (chat_member, реакции, business_*) —
 * каждый занимает слот раннера, а старый local-сервер мог бы отвергнуть незнакомые имена. */
export const ALLOWED_UPDATES = ["message", "callback_query", "inline_query", "chosen_inline_result"];

export interface BuildBotOptions {
  token: string;
  /** BOT_API_BASE_URL (с `/bot` или без); пусто — облако. */
  apiBaseUrl?: string;
  container: Container;
  /** хранилище стека диалогов (Redis в проде, MemoryStorage в тестах/smoke). */
  dialogStorage: StorageAdapter<DialogState>;
  /** алерт админу на ошибку хендлера (троттлинг — на стороне алертера). */
  onHandlerError?: (msg: string) => void;
  /** транспорт Bot API (тесты); дефолт — глобальный fetch. */
  fetch?: typeof fetch;
}

export function buildBot(o: BuildBotOptions): AppBot {
  const apiRoot = apiRootOf(o.apiBaseUrl ?? "");
  const base = new Bot(o.token, { ...(apiRoot ? { apiRoot } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) });

  // гейт ответов на dlg-кнопки — строго ДО плагина morda (см. dialogAnswerGate)
  base.use(dialogAnswerGate());
  // ретрай 429/5xx/сети только для вызовов morda: before — до плагина, after — сразу после
  const retry = mordaRetry();
  base.use(retry.before);
  // install ДО registerHandlers: derive ctx.dialog должен стоять раньше хендлеров команд
  const { plugin, dialogs } = createMenuDialogs(base, o.container, o.dialogStorage);
  const bot = base.install(plugin) as unknown as AppBot;
  bot.use(retry.after);
  o.container.dialogs = dialogs;

  // Реестр «кто писал боту в личку» — источник получателей для /broadcast.
  // knownChatsDb читаем лениво на каждый вызов: на момент апдейта container.start() уже заполнит поле.
  bot.use((ctx, next) => {
    const chat = ctx.chat;
    if (chat?.type === "private" && typeof chat.id === "number") {
      void o.container.knownChatsDb?.touch(chat.id).catch((e: unknown) => log.debug(`[known_chats] touch: ${e}`));
    }
    return next();
  });

  registerHandlers(bot, o.container);

  // Ловит исключения в хендлерах, чтобы throw не ронял обработку апдейта целиком.
  // kind — как у GramIO onError: TELEGRAM для ответов Bot API, иначе UNKNOWN.
  bot.onError((error) => {
    const kind = error instanceof TelegramError ? "TELEGRAM" : "UNKNOWN";
    const msg = `${kind}: ${(error as Error | undefined)?.message ?? error}`;
    log.error(`[onError] ${msg}`);
    incCounter("errors_total");
    o.onHandlerError?.(msg);
  });

  return bot;
}
