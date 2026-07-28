/**
 * token-bucket per-user.
 *
 * ВАЖНО: используем МОНОТОННЫЕ часы (performance.now), а не Date.now —
 * перевод системного времени не должен ломать refill.
 */
import { getLogger } from "./logging.ts";
import { sleep } from "./async.ts";

const log = getLogger("infra.rate_limit");

/** монотонное время в секундах */
function monotonic(): number {
  return performance.now() / 1000;
}

/** Блокирующий токен-бакет: `acquire()` ЖДЁТ, пока освободится токен (в отличие
 * от TokenBucket.consume, который лишь сообщает можно/нет). Burst мгновенных
 * вызовов + долив 1 токена за refillMs: интерактивные потоки не платят задержку,
 * массовые — спейсятся. */
export class AsyncTokenGate {
  private tokens: number;
  private lastRefill = performance.now();

  constructor(
    private readonly burst: number,
    private readonly refillMs: number,
  ) {
    this.tokens = burst;
  }

  async acquire(): Promise<void> {
    // while-loop: после sleep другая корутина могла уже потребить токен,
    // поэтому пересчитываем состояние после каждого пробуждения.
    while (true) {
      const now = performance.now();
      this.tokens = Math.min(this.burst, this.tokens + (now - this.lastRefill) / this.refillMs);
      this.lastRefill = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const wait = (1 - this.tokens) * this.refillMs;
      await sleep(wait);
    }
  }
}

export class TokenBucket {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly ratePerSecond: number;
  private lastRefill: number;

  constructor(tokens: number, maxTokens: number, ratePerSecond: number) {
    this.tokens = tokens;
    this.maxTokens = maxTokens;
    this.ratePerSecond = ratePerSecond;
    this.lastRefill = monotonic();
  }

  consume(amount = 1.0): boolean {
    const now = monotonic();
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + (now - this.lastRefill) * this.ratePerSecond,
    );
    this.lastRefill = now;
    if (this.tokens >= amount) {
      this.tokens -= amount;
      return true;
    }
    return false;
  }

  secondsUntilAvailable(amount = 1.0): number {
    const deficit = amount - this.tokens;
    return Math.max(0, deficit / this.ratePerSecond);
  }

  /** true, если бакет давно не использовался и почти полон — можно удалить из Map. */
  isStale(now: number, inactiveSeconds = 600): boolean {
    return now - this.lastRefill > inactiveSeconds && this.tokens >= this.maxTokens * 0.9;
  }
}

export class UserRateLimiter {
  readonly maxTokens: number;
  readonly ratePerSecond: number;
  readonly cleanupInterval: number;
  private readonly buckets = new Map<number, TokenBucket>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(maxTokens: number, ratePerSecond: number, cleanupInterval = 300) {
    this.maxTokens = maxTokens;
    this.ratePerSecond = ratePerSecond;
    this.cleanupInterval = cleanupInterval;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      try {
        this.cleanupInactive();
      } catch (e) {
        log.error(`[rate_limit] ошибка очистки: ${String(e)}`);
      }
    }, this.cleanupInterval * 1000);
    this.timer.unref?.();
  }

  private cleanupInactive(): void {
    const now = monotonic();
    let removed = 0;
    for (const [uid, b] of this.buckets) {
      if (b.isStale(now)) {
        this.buckets.delete(uid);
        removed += 1;
      }
    }
    if (removed) log.debug(`[rate_limit] почищено ${removed} неактивных bucket'ов`);
  }

  /** возвращает [allowed, retryAfterSeconds] */
  check(userId: number, cost = 1.0): [boolean, number] {
    let bucket = this.buckets.get(userId);
    if (bucket === undefined) {
      bucket = new TokenBucket(this.maxTokens, this.maxTokens, this.ratePerSecond);
      this.buckets.set(userId, bucket);
    }
    const allowed = bucket.consume(cost);
    const retryAfter = allowed ? 0 : bucket.secondsUntilAvailable(cost);
    return [allowed, retryAfter];
  }

  shutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
