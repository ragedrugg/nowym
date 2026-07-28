/**
 * Глобальный лимит параллельных скачиваний с CDN яндекса. Семафор + счётчик
 * активных задач. enqueue принимает ФАБРИКУ промиса — работа не стартует до
 * получения слота.
 */
import { Semaphore } from "./semaphore.ts";

export class DownloadConcurrency {
  private readonly sem: Semaphore;
  private activeCount = 0;

  constructor(globalConcurrency = 6) {
    this.sem = new Semaphore(globalConcurrency);
  }

  async enqueue<T>(factory: () => Promise<T>): Promise<T> {
    return this.sem.run(async () => {
      this.activeCount += 1;
      try {
        return await factory();
      } finally {
        this.activeCount -= 1;
      }
    });
  }

  active(): number {
    return this.activeCount;
  }
}
