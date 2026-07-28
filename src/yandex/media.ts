/** Обложки яндекса. */
import type { HttpClient } from "../infra/http.ts";
import { getLogger } from "../infra/logging.ts";

const log = getLogger("yandex.media");

/** cover_uri от яндекса → HTTPS URL. размер: 400x400 / orig. */
export function normalizeCoverUrl(uri: string | null | undefined, size = "400x400"): string {
  if (!uri) return "";
  const url = uri.replace("%%", size);
  if (url.startsWith("//")) return "https:" + url;
  if (!url.startsWith("http")) return "https://" + url;
  return url;
}

/** тот же cover_url, но в оригинальном размере — для вшивания в файл (/orig).
 * Миниатюра для Telegram остаётся в исходном (мелком) размере. */
export function origCoverUrl(url: string): string {
  if (!url) return "";
  return url.replace(/\/\d+x\d+(?=$|\?)/, "/orig");
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
