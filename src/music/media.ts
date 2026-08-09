/** Обложки Spotify — их URL уже полный (i.scdn.co/image/<hash>). */
import type { HttpClient } from "../infra/http.ts";
import { getLogger } from "../infra/logging.ts";

const log = getLogger("music.media");

/** cover_uri у Spotify — сразу полный HTTPS URL от i.scdn.co. size остаётся
 *  как аргумент для совместимости, но игнорируется — Spotify отдаёт
 *  фиксированные размеры (640/300/64), первый и берём. */
export function normalizeCoverUrl(uri: string | null | undefined, _size = "400x400"): string {
  if (!uri) return "";
  if (uri.startsWith("//")) return `https:${uri}`;
  if (!uri.startsWith("http")) return `https://${uri}`;
  return uri;
}

/** Раньше подменяли размер на /orig для вшивания в файл — у Spotify это тот же
 *  URL (лучший размер уже в 640×640), возвращаем как есть. */
export function origCoverUrl(url: string): string {
  return url;
}

export async function fetchCover(url: string, http: HttpClient): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const res = await http.request(url);
    if (res.status === 200) return Buffer.from(await res.body.arrayBuffer());
    await res.body.dump();
    log.warning(`обложка HTTP ${res.status}: ${url}`);
  } catch (e) {
    log.warning(`не вышло скачать обложку ${url}: ${e}`);
  }
  return null;
}
