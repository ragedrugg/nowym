import { getLogger } from "./logging.ts";

const log = getLogger("infra.gc");

/** Принудительный GC после тяжёлой работы (альбом: десятки FLAC-буферов вне JS-heap).
 * Без него V8 долго не трогает внешние буферы, и RSS остаётся раздутым часами.
 * Работает только с --expose-gc (ecosystem.config.cjs); без флага — no-op. */
export function collectGarbage(reason: string): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== "function") return;
  const before = process.memoryUsage().rss;
  gc();
  const after = process.memoryUsage().rss;
  log.debug(`[gc] ${reason}: rss ${Math.round(before / 1e6)} → ${Math.round(after / 1e6)} MB`);
}
