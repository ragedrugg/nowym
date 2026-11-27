/** Сторож long-polling (только режим BOT_API_BASE_URL; webhook не трогает).
 *
 * Фиксирует завершение каждого getUpdates (успех или ошибка — цикл жив) через
 * hook, которым watchedRunnerBot оборачивает getUpdates цикла @yaebal/runner (у
 * раннера своих хуков нет, а api.before/after не умеют оборвать висящий запрос).
 * Если ни один getUpdates не завершился дольше stallMs:
 *  1) висящий запрос обрывается ошибкой PollingStalledError (и его fetch абортится) —
 *     раннер ловит её в onError и после своего backoff (3с→30с) шлёт новый getUpdates
 *     (рестарт in-process: stop() раннера ждёт дренажа апдейтов, а повторный run()
 *     при висящем fetch оставил бы второй живой цикл);
 *  2) если и после этого за stallMs ни одного завершения (или висит не getUpdates) —
 *     onFatal: процесс выходит с ненулевым кодом, pm2 поднимает заново.
 * Если рвать нечего (запроса нет: раннер спит в backoff между попытками), сначала
 * даётся одно окно stallMs на восстановление, а известный retry_after из ответа 429
 * (TelegramError.parameters.retry_after) сдвигает порог целиком.
 * Heartbeat засчитывается только от текущего запроса (токен на вызов): поздний
 * ответ оборванного запроса не маскирует зависание нового.
 * Потолок раннера (concurrency) — не зависание: на нём раннер сам не зовёт getUpdates
 * (backpressure), пока апдейты в работе не освободят слот. watchedRunnerBot считает
 * апдейты в работе, и пока их ≥ concurrency, сторож считает цикл живым (без обрыва/выхода).
 * Один setInterval на весь процесс. */
import type { RunnerBot } from "@yaebal/runner";
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
  /** потолок апдейтов в работе у раннера; на нём отсутствие getUpdates — backpressure, не зависание. */
  concurrency?: number;
}

export class PollingWatchdog {
  private readonly stallMs: number;
  private readonly checkEveryMs: number;
  private readonly onFatal: (reason: string) => void;
  private readonly concurrency: number;
  /** апдейты в работе (считает watchedRunnerBot вокруг handleUpdate). */
  private inflight = 0;
  /** уже залогировано, что раннер упёрся в потолок (лог раз на эпизод). */
  private atCap = false;
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
    this.concurrency = o.concurrency ?? Number.POSITIVE_INFINITY;
  }

  /** обёртка одного handleUpdate: считает апдейты в работе (см. watchedRunnerBot). */
  async track<T>(work: () => Promise<T>): Promise<T> {
    this.inflight++;
    try {
      return await work();
    } finally {
      this.inflight--;
    }
  }

  /** обёртка одного getUpdates: `wd.hook(null, () => api.getUpdates(...))` (см. watchedRunnerBot). */
  readonly hook = (_ctx: unknown, next: () => Promise<unknown>): Promise<unknown> => {
    const token = ++this.seq;
    this.currentToken = token;
    const call = next().then(
      (v) => {
        this.beat(token, v); // ошибка, возвращённая значением, тоже несёт retry_after
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
    // yaebal TelegramError: retry_after лежит в .parameters (у GramIO было .payload)
    const retryAfterSec = (outcome as { parameters?: { retry_after?: unknown } } | null)?.parameters?.retry_after;
    const retryAfterMs = typeof retryAfterSec === "number" && retryAfterSec > 0 ? retryAfterSec * 1000 : 0;
    // пауза retry_after до следующего getUpdates — не зависание
    this.lastBeat = Date.now() + retryAfterMs;
    if (this.interruptedAt !== null) {
      log.info("[watchdog] getUpdates снова завершается — polling восстановлен");
      this.interruptedAt = null;
      this.recovery = null;
    }
  }

  private check(): void {
    const now = Date.now();
    if (this.inflight >= this.concurrency) {
      // раннер на потолке и сам не зовёт getUpdates — цикл жив, ждёт слота
      if (!this.atCap) {
        this.atCap = true;
        log.warning(
          `[watchdog] раннер на потолке (${this.inflight} апдейтов в работе) — getUpdates на паузе, не зависание`,
        );
      }
      this.lastBeat = now;
      this.interruptedAt = null;
      this.recovery = null;
      return;
    }
    if (this.atCap) {
      this.atCap = false;
      log.info("[watchdog] раннер ниже потолка — getUpdates возобновится");
    }
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
          "(раннер ждёт перед повтором?) — даю окно на восстановление",
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

/** RunnerBot, обёрнутый watchedRunnerBot: знает максимальный update_id, отданный раннеру. */
export type PolledRunnerBot = RunnerBot & {
  /** максимальный update_id из ответов getUpdates, дошедших до раннера; -1 — ещё ни одного. */
  maxUpdateId(): number;
};

/** RunnerBot для @yaebal/runner, чей getUpdates идёт через сторожа: обрыв сторожем
 * абортит и сам fetch (сигнал раннера на stop() тоже пробрасывается). wd=null — без сторожа.
 * Всегда помнит максимальный update_id из полученных пачек (для confirmPolledOffset).
 * onPollFailing: getUpdates падает failAlertAfter раз подряд (сторож такой цикл живым и
 * считает — ошибка тоже «завершение», а раннер только логирует) — зовётся один раз на серию. */
export function watchedRunnerBot(
  bot: RunnerBot,
  wd: PollingWatchdog | null,
  opts: { failAlertAfter?: number; onPollFailing?: (failures: number, error: unknown) => void } = {},
): PolledRunnerBot {
  const failAlertAfter = opts.failAlertAfter ?? 5;
  let failures = 0;
  const onOk = (): void => {
    if (failures >= failAlertAfter) log.info(`[polling] getUpdates снова проходит после ${failures} ошибок подряд`);
    failures = 0;
  };
  const onFail = (e: unknown): never => {
    failures++;
    if (failures === failAlertAfter) opts.onPollFailing?.(failures, e);
    throw e;
  };
  let maxId = -1;
  const remember = (updates: Awaited<ReturnType<RunnerBot["api"]["getUpdates"]>>) => {
    onOk();
    for (const u of updates) if (u.update_id > maxId) maxId = u.update_id;
    return updates;
  };
  const getUpdates: RunnerBot["api"]["getUpdates"] = (params, options) => {
    if (!wd) return bot.api.getUpdates(params, options).then(remember, onFail);
    const ac = new AbortController();
    const outer = options?.signal;
    const onOuterAbort = (): void => ac.abort(outer?.reason);
    if (outer?.aborted) ac.abort(outer.reason);
    else outer?.addEventListener("abort", onOuterAbort, { once: true });
    return (
      wd.hook(null, () => bot.api.getUpdates(params, { signal: ac.signal })) as ReturnType<
        RunnerBot["api"]["getUpdates"]
      >
    )
      .then(remember, onFail)
      .catch((e: unknown) => {
        if (e instanceof PollingStalledError) ac.abort(e);
        throw e;
      })
      .finally(() => outer?.removeEventListener("abort", onOuterAbort));
  };
  return {
    api: { getUpdates },
    handleUpdate: (update) => (wd ? wd.track(() => bot.handleUpdate(update)) : bot.handleUpdate(update)),
    ...(bot.init ? { init: () => bot.init!() } : {}),
    ...(bot.allowedUpdates ? { allowedUpdates: () => bot.allowedUpdates!() } : {}),
    maxUpdateId: () => maxId,
  };
}

/** Подтвердить Telegram всё до maxUpdateId включительно (getUpdates с offset=max+1), чтобы
 * после рестарта не прилетела заново последняя пачка. Зовётся на shutdown сразу после
 * runner.stop() (тот абортит long-poll): штатное подтверждение раннера ждёт дренажа апдейтов
 * в работе и при скачивании дольше 5с не успевает до выхода. Апдейты, ещё не дообработанные к
 * выходу, теряются — это осознанный выбор вместо повторной выгрузки/скачивания. */
export async function confirmPolledOffset(api: RunnerBot["api"], maxUpdateId: number, timeoutMs = 3000): Promise<void> {
  if (maxUpdateId < 0) return;
  await api.getUpdates({ offset: maxUpdateId + 1, limit: 1, timeout: 0 }, { signal: AbortSignal.timeout(timeoutMs) });
}
