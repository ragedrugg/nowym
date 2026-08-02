/** Простой асинхронный семафор (счётный). Аналог asyncio.Semaphore. */
export class Semaphore {
  private permits: number;
  private readonly maxPermits: number;
  private readonly waiters: Array<() => void> = [];
  // сколько acquire() сейчас удерживают permit без парного release() — без
  // этого счётчика лишний release(), пришедший пока кто-то уже ждёт (то есть
  // все permits заняты), передал бы ожидающему "фантомный" permit и мог
  // пробить потолок при следующем legit release() того же держателя.
  private outstanding = 0;

  constructor(permits: number) {
    this.permits = permits;
    this.maxPermits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      this.outstanding += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.outstanding += 1;
  }

  release(): void {
    // лишний release без парного acquire игнорируем — не пробиваем потолок
    if (this.outstanding <= 0) return;
    this.outstanding -= 1;
    const next = this.waiters.shift();
    if (next) {
      // permit передаётся напрямую следующему ожидающему
      next();
    } else if (this.permits < this.maxPermits) {
      this.permits += 1;
    }
  }

  /** Выполнить fn, удерживая один permit. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
