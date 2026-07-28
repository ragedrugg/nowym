/** Мелкие async-утилиты общего назначения. */

/** Пауза. Если передан signal — резолвится досрочно при abort (без reject). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/** Прерываемый sleep: `sleep(ms)` ждёт, `wake()` будит текущий sleep досрочно
 * (без reject). Один in-flight таймер: wake всегда указывает на последний
 * запущенный sleep. */
export function createInterruptibleSleep(): {
  sleep: (ms: number) => Promise<void>;
  wake: () => void;
} {
  let wake: (() => void) | null = null;
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(t);
        wake = null;
        resolve();
      };
    });
  return { sleep, wake: () => wake?.() };
}

/** Реджектит промис, если он не успел за ms. Сам по себе работу НЕ отменяет —
 * для отмены осиротевшей работы заведи AbortController и вызови abort() в catch. */
export function withTimeout<T>(p: Promise<T>, ms: number, label = "timeout"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
