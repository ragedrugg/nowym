import { getLogger } from "../../../infra/logging.ts";
import type { CachedTrack } from "../../../storage/types.ts";
import { losslessUrlPicker, type YandexClient, YandexUnavailableError } from "../../../yandex/client.ts";
import {
  type AudioQuality,
  buildTrackMetadata,
  enrichMetadataFromAlbum,
  trackIsTooLong,
} from "../../../yandex/metadata.ts";
import type { YaTrack } from "../../../yandex/types.ts";
import type { Container } from "../../container.ts";
import { AUDIO_EFFECTS, type AudioEffect, EFFECT_BITRATE } from "./shared.ts";

const log = getLogger("bot.inline");

/** unavailable — Яндекс не ответил на getTrackById: trackObj=null, но кэш (cached и тиры в
 * ensureFileId) ещё может выручить; «Яндекс не отвечает» — только после промаха всех тиров. */
type ResolveResult = {
  cached: CachedTrack | null;
  trackObj: YaTrack | null;
  yandex: YandexClient;
  unavailable: boolean;
};

/** lossless — отдельный тир кэша; переданный lossy-`cached` для него не годится. */
async function resolveCacheEntry(
  container: Container,
  trackId: string,
  quality: AudioQuality,
  cached: CachedTrack | null,
): Promise<CachedTrack | null> {
  if (quality === "lossless" || quality === "economy") return await container.cacheDb.get(trackId, quality);
  return cached;
}

/** тир кэша для lossy-закачки: economy (≤192) не должен затирать/подменять оптимальное. */
function lossyTier(quality: AudioQuality): string {
  return quality === "economy" ? "economy" : "lossy";
}

export async function resolveTrack(
  container: Container,
  token: string,
  userId: number,
  trackId: string,
  trackObj: YaTrack | null = null,
): Promise<ResolveResult> {
  const trackService = await container.getTrackService(token, userId);
  const yandex = await container.getYandexService(token, userId);

  let obj = trackObj ?? trackService.getTrackObject(trackId);
  let cached: CachedTrack | null;
  let unavailable = false;
  if (obj !== null) {
    cached = await container.cacheDb.get(trackId);
  } else {
    [cached, obj] = await Promise.all([
      container.cacheDb.get(trackId),
      yandex.getTrackById(Number(trackId), { strict: true }).catch((e: unknown) => {
        if (!(e instanceof YandexUnavailableError)) throw e;
        log.warning(`[resolve] ${e.message} track=${trackId} — пробую кэш`);
        unavailable = true;
        return null;
      }),
    ]);
    if (obj) trackService.cacheTrackObject(obj);
  }
  return { cached, trackObj: obj, yandex, unavailable };
}

/** lossless (raw flac-mp4, без шифрования); кэш под своим тиром. lossy-ответ приходит как null → вызывающий деградирует. */
async function downloadFreshTrackLossless(
  container: Container,
  trackObj: YaTrack,
  yandex: YandexClient,
  trackId: string,
): Promise<[boolean, string | null, string | null, number | null]> {
  const [metadata, info] = await Promise.all([
    enrichMetadataFromAlbum(buildTrackMetadata(trackObj), trackObj, yandex),
    yandex.getLosslessDownload(trackObj),
  ]);
  if (info === null) return [false, null, null, null];
  const meta = { ...metadata, codec: info.codec, bitrate_kbps: info.bitrate };
  // каждая racing-попытка берёт случайный url из списка; протухший список обновляется один раз.
  const pickUrl = losslessUrlPicker(info, () => yandex.getLosslessDownload(trackObj));
  const fileId = await container.cacheService.downloadAndCacheTrack(trackId, pickUrl, meta, info.codec, "lossless");
  return [true, fileId, info.codec ?? null, info.bitrate ?? null];
}

/** возвращает [infoFound, fileId, codec, bitrateKbps]. */
async function downloadFreshTrackBest(
  container: Container,
  trackObj: YaTrack,
  yandex: YandexClient,
  trackId: string,
  quality: AudioQuality,
): Promise<[boolean, string | null, string | null, number | null]> {
  const [metadata, info] = await Promise.all([
    enrichMetadataFromAlbum(buildTrackMetadata(trackObj), trackObj, yandex),
    yandex.getBestDownloadInfo(trackObj, quality),
  ]);
  if (info === null) return [false, null, null, null];
  const meta = { ...metadata, codec: info.codec, bitrate_kbps: info.bitrateInKbps };
  const fileId = await container.cacheService.downloadAndCacheTrack(
    trackId,
    () => yandex.directLinkFromInfo(info),
    meta,
    info.codec,
    lossyTier(quality),
  );
  return [true, fileId, info.codec, info.bitrateInKbps];
}

/** degraded=true — запрошен lossless, но он не отдался, молча отдали lossy. */
async function downloadFreshTrack(
  container: Container,
  trackObj: YaTrack,
  yandex: YandexClient,
  trackId: string,
  quality: AudioQuality = "best",
): Promise<[boolean, string | null, string | null, number | null, boolean]> {
  if (quality === "lossless") {
    try {
      const r = await downloadFreshTrackLossless(container, trackObj, yandex, trackId);
      if (r[1]) return [r[0], r[1], r[2], r[3], false];
      log.warning(`[lossless] недоступен track=${trackId} → фолбэк на mp3`);
    } catch (e) {
      log.warning(`[lossless] сбой track=${trackId}: ${e} → фолбэк на mp3`);
    }
    // уже есть lossy-копия в кэше — отдаём её, а не качаем mp3 заново
    const lossy = await container.cacheDb.get(trackId, "lossy").catch(() => null);
    if (lossy?.is_cached) return [true, lossy.telegram_file_id, lossy.codec, lossy.bitrate_kbps, true];
    // degraded только если фолбэк реально удался
    const fb = await downloadFreshTrackBest(container, trackObj, yandex, trackId, "best");
    return [fb[0], fb[1], fb[2], fb[3], fb[1] !== null];
  }
  const r = await downloadFreshTrackBest(container, trackObj, yandex, trackId, quality);
  return [r[0], r[1], r[2], r[3], false];
}

/** качаем lossy-исходник, перекодируем ffmpeg-фильтром, кэш — свой тир per-эффект. */
async function buildEffectTrack(
  container: Container,
  trackObj: YaTrack,
  yandex: YandexClient,
  trackId: string,
  effect: AudioEffect,
  tier: string,
): Promise<string | null> {
  // кэш этого тира проверил ensureFileId — сюда доходим только на промахе
  const [metadata, info] = await Promise.all([
    enrichMetadataFromAlbum(buildTrackMetadata(trackObj), trackObj, yandex),
    yandex.getBestDownloadInfo(trackObj, "best"),
  ]);
  if (info === null) return null;

  const meta = {
    ...metadata,
    title: `${metadata.title} ${effect.suffix}`,
    codec: "mp3",
    bitrate_kbps: EFFECT_BITRATE,
    duration: Math.round((metadata.duration || 0) / effect.speedFactor), // иначе плеер покажет старую длину
  };
  return container.cacheService.downloadAndCacheTrack(
    trackId,
    () => yandex.directLinkFromInfo(info),
    meta,
    info.codec,
    tier,
    { filter: effect.filter },
  );
}

/** kind'ы ровно те, что call-сайты различают своими текстами; ok=false — уже финал. */
export type EnsureResult =
  | { ok: true; fileId: string; codec: string | null; bitrateKbps: number | null; degraded: boolean }
  | { ok: false; kind: "not_found" | "too_long" | "no_variants" | "failed" | "unavailable" };

/** единственная реализация «взять file_id: есть в кэше — отдать, нет — скачать».
 * tier — аудио-эффект (ncore/speed/slow): свой тир кэша и сборка ffmpeg'ом вместо
 * обычной загрузки. onDownloadStart зовётся, только если дело дошло до скачивания. */
export async function ensureFileId(
  container: Container,
  cached: CachedTrack | null,
  trackObj: YaTrack | null,
  yandex: YandexClient,
  trackId: string,
  opts: {
    quality?: AudioQuality;
    tier?: string | null;
    onDownloadStart?: () => Promise<void>;
    /** trackObj=null из-за сбоя Яндекса (resolveTrack), а не «нет такого трека». */
    unavailable?: boolean;
  } = {},
): Promise<EnsureResult> {
  const { quality = "best", tier = null, onDownloadStart, unavailable = false } = opts;
  const effect = tier ? AUDIO_EFFECTS[tier] : undefined;

  const entry = effect
    ? await container.cacheDb.get(trackId, tier!)
    : await resolveCacheEntry(container, trackId, quality, cached);
  if (entry && entry.is_cached) {
    const fileId = entry.telegram_file_id;
    return effect
      ? { ok: true, fileId, codec: "mp3", bitrateKbps: EFFECT_BITRATE, degraded: false }
      : { ok: true, fileId, codec: entry.codec, bitrateKbps: entry.bitrate_kbps, degraded: false };
  }

  if (trackObj === null) return { ok: false, kind: unavailable ? "unavailable" : "not_found" };
  if (trackIsTooLong(trackObj)) return { ok: false, kind: "too_long" };
  if (onDownloadStart) await onDownloadStart();

  if (effect) {
    const fileId = await buildEffectTrack(container, trackObj, yandex, trackId, effect, tier!);
    return fileId
      ? { ok: true, fileId, codec: "mp3", bitrateKbps: EFFECT_BITRATE, degraded: false }
      : { ok: false, kind: "failed" };
  }

  const [infoFound, fileId, codec, bitrateKbps, degraded] = await downloadFreshTrack(
    container,
    trackObj,
    yandex,
    trackId,
    quality,
  );
  if (!infoFound) return { ok: false, kind: "no_variants" };
  if (!fileId) return { ok: false, kind: "failed" };
  return { ok: true, fileId, codec, bitrateKbps, degraded };
}
