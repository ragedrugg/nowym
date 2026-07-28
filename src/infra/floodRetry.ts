/** Повтор вызова при 429 (Telegram flood control).
 *
 * `build` ОБЯЗАН пересоздавать payload на каждой попытке: FormData с медиа
 * одноразовый — повтор того же объекта уходит без файла. */
import { sleep } from "./async.ts";

/** retry_after из payload ошибки GramIO, если это 429 (иначе undefined). */
function retryAfterOf(e: unknown): number | undefined {
  return (e as { payload?: { retry_after?: number } })?.payload?.retry_after;
}

export interface FloodRetryOpts {
  /** максимум попыток (по умолчанию без потолка — для длинных джобов). */
  attempts?: number;
  /** добавка к ожиданию retry_after, мс (страховой запас). */
  graceMs?: number;
  /** колбэк перед ожиданием — для лога. */
  onWait?: (retryAfter: number, attempt: number) => void;
}

export async function floodRetry<T>(build: () => Promise<T>, opts: FloodRetryOpts = {}): Promise<T> {
  const { attempts = Infinity, graceMs = 0, onWait } = opts;
  for (let attempt = 1; ; attempt++) {
    try {
      return await build();
    } catch (e) {
      const retryAfter = retryAfterOf(e);
      // retryAfter может быть 0 (валидный "ретрай прямо сейчас") — !retryAfter
      // тут ложно трактовал бы его как "это не 429" и пробрасывал ошибку дальше.
      if (retryAfter === undefined || attempt >= attempts) throw e;
      onWait?.(retryAfter, attempt);
      await sleep(retryAfter * 1000 + graceMs);
    }
  }
}
