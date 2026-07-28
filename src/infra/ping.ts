/** замер latency до апстрима для /health. */
import type { HttpClient } from "./http.ts";

/** один HEAD/GET-замер, возвращает мс или null при ошибке. */
export async function measureLatency(url: string, http: HttpClient): Promise<number | null> {
  const start = performance.now();
  try {
    const res = await http.request(url, { method: "GET" });
    const ms = performance.now() - start; // время до заголовков (RTT), а не до полного тела
    await res.body.dump().catch(() => undefined); // освобождаем соединение, не считая это латентностью
    return ms;
  } catch {
    return null;
  }
}

export function formatLatency(ms: number | null): string {
  if (ms === null) return "недоступно";
  return `${Math.round(ms)} мс`;
}
