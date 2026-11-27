/** Узкий ретрай вызовов morda (edit/send/delete меню-сообщения).
 *
 * morda на ЛЮБУЮ ошибку edit (кроме «not modified») удаляет меню и шлёт новое; если и
 * отправка падает (тот же 429, 5xx local Bot API, обрыв fetch) — сообщение уже удалено,
 * а состояние указывает на него: меню потеряно до /start. Поэтому её вызовы получают
 * один повтор: 429 — после retry_after (если он не больше MAX_RETRY_AFTER_SEC),
 * 5xx/сетевая ошибка — через TRANSIENT_DELAY_MS. 4xx не трогаем — это законный повод
 * morda для delete+resend.
 *
 * Область: только morda. ctx.api подменяется ретраящей обёрткой ПЕРЕД плагином
 * (derive ctx.dialog захватывает её) и возвращается сразу ПОСЛЕ него — хендлеры дальше
 * по цепочке видят обычный api (там свой floodRetry, слои не складываем). Обёртка
 * перехватывает только api.call(...): им пользуется morda (и ctx-сахар core внутри
 * onClick); api.<method>() идёт мимо неё. Для background() обёртку передаёт dialogs.ts. */
import { type Api, type Context, HttpError, type Middleware, TelegramError } from "yaebal";
import { sleep as realSleep } from "../infra/async.ts";
import { getLogger } from "../infra/logging.ts";

const log = getLogger("bot.morda_retry");

/** методы, которыми morda рисует/убирает меню (deliver.ts). */
const RETRIED = new Set([
  "editMessageText",
  "editMessageMedia",
  "editMessageReplyMarkup",
  "sendMessage",
  "sendPhoto",
  "sendVideo",
  "sendAnimation",
  "sendDocument",
  "sendAudio",
  "deleteMessage",
]);

/** дольше ждать retry_after в клике не стоит — пусть morda отработает как есть. */
export const MAX_RETRY_AFTER_SEC = 30;
export const TRANSIENT_DELAY_MS = 1000;

/** сколько ждать перед повтором; null — не повторять. */
function retryDelayMs(e: unknown): number | null {
  if (e instanceof TelegramError) {
    if (e.code === 429) {
      const ra = e.parameters?.retry_after;
      return typeof ra === "number" && ra >= 0 && ra <= MAX_RETRY_AFTER_SEC ? ra * 1000 : null;
    }
    return e.code >= 500 ? TRANSIENT_DELAY_MS : null;
  }
  if (e instanceof HttpError) return e.status >= 500 ? TRANSIENT_DELAY_MS : null;
  if ((e as Error | undefined)?.name === "AbortError") return null;
  return e instanceof Error ? TRANSIENT_DELAY_MS : null; // fetch failed / ECONNRESET
}

/** api, у которого call(method) для методов morda повторяется один раз на 429/5xx/сеть. */
export function retryingApi(api: Api, sleep: (ms: number) => Promise<void> = realSleep): Api {
  const call = (async (method: string, params?: Record<string, unknown>, options?: unknown) => {
    const once = () => (api.call as (m: string, p?: unknown, o?: unknown) => Promise<unknown>)(method, params, options);
    if (!RETRIED.has(method)) return once();
    try {
      return await once();
    } catch (e) {
      const ms = retryDelayMs(e);
      if (ms === null) throw e;
      log.warning(`[morda] ${method} упал (${(e as Error).message}) — повтор через ${ms}ms`);
      await sleep(ms);
      return once();
    }
  }) as Api["call"];
  return new Proxy(api, {
    get: (target, prop, receiver) => (prop === "call" ? call : Reflect.get(target, prop, receiver)),
  });
}

const ORIGINAL = Symbol("mordaRetry.original");

function setApi(ctx: Context, api: Api): void {
  Object.defineProperty(ctx, "api", { value: api, configurable: true, writable: true, enumerable: true });
}

/** before — строго ДО плагина morda, after — сразу ПОСЛЕ него. */
export function mordaRetry<C extends Context>(): { before: Middleware<C>; after: Middleware<C> } {
  return {
    before: async (ctx, next) => {
      const orig = ctx.api;
      (ctx as unknown as Record<symbol, Api>)[ORIGINAL] = orig;
      setApi(ctx, retryingApi(orig));
      try {
        await next();
      } finally {
        setApi(ctx, orig);
      }
    },
    after: (ctx, next) => {
      const orig = (ctx as unknown as Record<symbol, Api | undefined>)[ORIGINAL];
      if (orig) setApi(ctx, orig);
      return next();
    },
  };
}
