/**
 * in-memory LRU+TTL кэш. Node однопоточный → без локов. LRU реализован
 * порядком вставки Map (delete+set = move_to_end).
 */
import { getLogger } from "./logging.ts";

const log = getLogger("infra.memory_cache");

interface Entry<V> {
  value: V;
  expiresAt: number; // секунды (wall clock)
}

export class TTLCache<V = unknown> {
  readonly maxSize: number;
  readonly defaultTtl: number;
  readonly cleanupInterval: number;

  private readonly cache = new Map<string, Entry<V>>();
  private hits = 0;
  private misses = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(maxSize = 1000, defaultTtl = 300, cleanupInterval = 60) {
    this.maxSize = maxSize;
    this.defaultTtl = defaultTtl;
    this.cleanupInterval = cleanupInterval;
  }

  private ensureCleanupStarted(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch (e) {
        log.error(`TTLCache cleanup error: ${String(e)}`);
      }
    }, this.cleanupInterval * 1000);
    // не держим event loop живым ради чистки кэша
    this.timer.unref?.();
  }

  private sweep(): void {
    const now = Date.now() / 1000;
    for (const [k, e] of this.cache) {
      if (e.expiresAt <= now) this.cache.delete(k);
    }
  }

  get(key: string): V | null {
    this.ensureCleanupStarted();
    const entry = this.cache.get(key);
    if (entry === undefined) {
      this.misses += 1;
      return null;
    }
    if (entry.expiresAt <= Date.now() / 1000) {
      this.cache.delete(key);
      this.misses += 1;
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key: string, value: V, ttl?: number): void {
    this.ensureCleanupStarted();
    const expiresAt = Date.now() / 1000 + (ttl ?? this.defaultTtl);
    if (this.cache.has(key)) {
      this.cache.delete(key);
      this.cache.set(key, { value, expiresAt });
      return;
    }
    while (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { value, expiresAt });
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  get size(): number {
    return this.cache.size;
  }

  stats(): { size: number; hits: number; misses: number; hit_rate: string } {
    const total = this.hits + this.misses;
    const hitRate = total ? (this.hits / total) * 100 : 0;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hit_rate: `${hitRate.toFixed(1)}%`,
    };
  }

  close(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.cache.clear();
  }
}
