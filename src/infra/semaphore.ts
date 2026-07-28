/** Простой асинхронный семафор (счётный). Аналог asyncio.Semaphore. */
export class Semaphore {
  private permits: number;
  private readonly maxPermits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
    this.maxPermits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // permit передаётся напрямую следующему ожидающему
      next();
    } else if (this.permits < this.maxPermits) {
      this.permits += 1;
    }
    // лишний release без парного acquire игнорируем — не пробиваем потолок
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
