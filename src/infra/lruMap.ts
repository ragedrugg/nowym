/** LRU-Map с потолком размера. Порядок вставки в Map = порядок свежести:
 * старейший ключ всегда первый в итерации. TTL-семантики тут нет (для неё —
 * TTLCache). */
export class LRUMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Чтение с бампом свежести (LRU-touch). undefined, если ключа нет. */
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  /** Чтение без бампа свежести. */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  /** Вставка/обновление + вытеснение старейших при превышении потолка. */
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** Чтение с удалением (бамп не нужен — значение всё равно уходит). */
  take(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    return v;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /** Итерация [key, value] от старейшего к свежайшему — для доменных свипов. */
  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }
}
