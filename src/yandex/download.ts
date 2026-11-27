/** Хелперы lossless-загрузки (get-file-info): выбор URL для racing-попыток и проверка кодека. */
import type { LosslessDownloadInfo as LibLosslessDownloadInfo } from "@dvxch/yandex-music";
import { getLogger } from "../infra/logging.ts";

const log = getLogger("yandex.client");

/** Ссылки get-file-info живут недолго; старше этого возраста список запрашиваем заново (один раз). */
const LOSSLESS_URL_TTL_MS = 45_000;

/** Выбор URL для racing-попыток: случайный из списка (спред по CDN); если список
 * старше ttlMs — один раз перезапрашиваем info (при сбое остаёмся на старых ссылках). */
export function losslessUrlPicker(
  info: LibLosslessDownloadInfo,
  refetch: () => Promise<LibLosslessDownloadInfo | null>,
  opts: { now?: () => number; ttlMs?: number } = {},
): () => Promise<string | null> {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? LOSSLESS_URL_TTL_MS;
  const startedAt = now();
  let urls = info.links();
  let refreshed = false;
  return async () => {
    if (!refreshed && now() - startedAt > ttlMs) {
      refreshed = true;
      try {
        const fresh = await refetch();
        const links = fresh?.links() ?? [];
        if (links.length > 0) urls = links;
      } catch (e) {
        log.debug(`обновление lossless-ссылок не вышло: ${e}`);
      }
    }
    return urls[Math.floor(Math.random() * urls.length)] ?? null;
  };
}

export function isLosslessInfo(info: LibLosslessDownloadInfo): boolean {
  if ((info as { isLossless?: boolean }).isLossless === true) return true;
  return typeof info.codec === "string" && info.codec.startsWith("flac");
}
