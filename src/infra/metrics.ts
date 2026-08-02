/** Минимальный in-memory реестр счётчиков для /metrics (Prometheus text exposition).
 * Без внешних зависимостей — счётчиков в проекте мало, полноценный prom-client избыточен. */
const counters = new Map<string, number>();

export function incCounter(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function counterSnapshot(): ReadonlyMap<string, number> {
  return counters;
}
