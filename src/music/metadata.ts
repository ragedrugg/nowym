/** TrackMetadata / CardMeta из сырых объектов Track (Spotify).
 *
 * приоритет источников:
 *   1. albumOverride (контекст альбома при выгрузке)
 *   2. track.albums[0] (упрощённый альбом из поиска / client.tracks)
 *   3. track.metaData (fallback из embed-структуры)
 *
 * enrichMetadataFromAlbum дёргает полный альбом, если в шаге 2 не хватило
 * year/label/genre. */
import { normalizeCoverUrl } from "./media.ts";
import type {
  Album,
  Artist,
  CardColors,
  CardMeta,
  Label,
  Track,
  TrackMetadata,
  TrackPosition,
} from "./types.ts";

// self-hosted Bot API (лимит файла 2гб) → длинные треки допустимы. Потолок 4.5ч.
const MAX_TRACK_DURATION_MS = 4.5 * 60 * 60 * 1000;

// потолок размера файла в RAM: качаем+тегируем в RAM (двойной буфер) при 7.8гб.
// >1.2гб → отказ ДО скачивания, иначе OOM-kill процесса (pm2 max_memory_restart).
export const MAX_TRACK_BYTES = 1.2 * 1024 ** 3;
// >200мб → «тяжёлый»: строго по одному (heavyLock) + без racing-параллелизма (solo-качка).
export const HEAVY_TRACK_BYTES = 200 * 1024 ** 2;

// yt-dlp по умолчанию отдаёт opus 128-160 kbps (bestaudio с YouTube). Для оценки
// размера — 160, а fallback-и на случай других кодеков.
const FALLBACK_KBPS: Record<string, number> = { opus: 160, mp3: 320, aac: 256, m4a: 256 };

export function estimateTrackBytes(durationSec: number, bitrateKbps?: number | null, codec?: string | null): number {
  if (!durationSec || durationSec <= 0) return 0;
  const codecKey = codec ?? "opus";
  const fallbackKbps = Object.hasOwn(FALLBACK_KBPS, codecKey) ? FALLBACK_KBPS[codecKey] : undefined;
  const kbps = bitrateKbps && bitrateKbps > 0 ? bitrateKbps : (fallbackKbps ?? 192);
  return Math.round(durationSec * kbps * 125 * 1.1); // *125 = *1000/8; *1.1 — запас на контейнер
}

// минимальные интерфейсы клиента — чтобы metadata не зависела от client.ts
export interface LikeProvider {
  isTrackLiked(trackId: number | string): Promise<boolean>;
}
export interface AlbumShortProvider {
  getAlbumShort(albumId: number | string): Promise<Album | null>;
}

export function trackIsTooLong(track: Track): boolean {
  const ms = track.durationMs;
  if (!ms) return false;
  return ms > MAX_TRACK_DURATION_MS;
}

/** ms → '30:45' / '1:23:45'. */
export function formatDurationHuman(durationMs: number | null | undefined): string {
  const s = Math.max(0, Math.floor((durationMs || 0) / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s >= 3600) return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** id как есть — у Spotify не бывает составных ":<album>". */
export function bareTrackId(id: number | string | null | undefined): string {
  return String(id).split(":")[0]!;
}

export function formatArtists(artists: Artist[] | null | undefined, def = "Unknown"): string {
  if (!artists || artists.length === 0) return def;
  const names = artists.map((a) => a.name).filter((n): n is string => Boolean(n));
  return names.length > 0 ? names.join(", ") : def;
}

export function formatTrackBasics(track: Track, defaultTitle = "—"): [string, string] {
  const artist = formatArtists(track.artists);
  const title = (track.title || defaultTitle).trim() || defaultTitle;
  return [artist, title];
}

function formatLabel(labels: Label[] | null | undefined): string {
  if (!labels || labels.length === 0) return "";
  const first = labels[0]!;
  if (typeof first === "string") return first;
  return first.name ? first.name : String(first);
}

function formatAllLabels(labels: Label[] | null | undefined): string[] {
  if (!labels || labels.length === 0) return [];
  return labels.map((l) => (typeof l === "string" ? l : (l.name ?? "")).trim()).filter(Boolean);
}

function strOrEmpty(v: unknown): string {
  return v ? String(v) : "";
}

function firstTruthy<T>(...values: T[]): T | null {
  for (const v of values) {
    if (v !== null && v !== undefined && (v as unknown) !== "" && (v as unknown) !== 0) return v;
  }
  return null;
}

function isExplicit(track: Track): boolean {
  return !!(track.contentWarning || track.explicit);
}

const ALBUM_TYPE_RU: Record<string, string> = {
  single: "сингл",
  ep: "EP",
  album: "альбом",
  compilation: "сборник",
  playlist: "плейлист",
};

export function albumTypeRu(
  albumType: string | null | undefined,
  trackCount: number | null | undefined = null,
): string | null {
  if (albumType) {
    const key = albumType.toLowerCase();
    if (Object.hasOwn(ALBUM_TYPE_RU, key)) return ALBUM_TYPE_RU[key]!;
  }
  if (trackCount === null || trackCount === undefined) return null;
  if (trackCount === 1) return "сингл";
  if (trackCount >= 2 && trackCount <= 6) return "EP";
  if (trackCount > 6) return "альбом";
  return null;
}

const ALBUM_TYPE_EMOJI: Record<string, string> = {
  playlist: "🎵",
  compilation: "📚",
};

export function albumEmoji(albumType: string | null | undefined): string {
  return (albumType && ALBUM_TYPE_EMOJI[albumType.toLowerCase()]) || "📀";
}

/** типы, для которых в meta-строке выгрузки явно показываем ru-ярлык. У Spotify
 *  таких «специальных» типов нет — сборник обычно и так узнаётся по обложке. */
export const LABELED_ALBUM_TYPES = new Set<string>(["compilation"]);

export function isSingle(albumType: string | null | undefined, trackCount: number | null | undefined = null): boolean {
  if (albumType && albumType.toLowerCase() === "single") return true;
  return trackCount === 1;
}

function derivedColors(track: Track): CardColors {
  const dc = track.derivedColors;
  if (!dc) return {};
  return {
    accent: dc.accent || "",
    average: dc.average || "",
    wave_text: dc.waveText || "",
  };
}

function trackPosition(track: Track, album: Album | null): [number | null, number | null] {
  for (const src of [album, track] as Array<{ trackPosition?: TrackPosition | null } | null>) {
    const tp = src ? src.trackPosition : null;
    if (tp) {
      const index = tp.index ?? null;
      const volume = tp.volume ?? null;
      if (index !== null || volume !== null) return [index, volume];
    }
  }
  return [null, null];
}

/** поля для meta-строки карточки. ничего не дёргает по сети. */
export function buildCardMeta(track: Track): CardMeta {
  const album = track.albums && track.albums.length > 0 ? track.albums[0]! : null;
  const trackCount = album ? (album.trackCount ?? null) : null;
  const rawType = album ? (album.type ?? null) : null;

  const albumTitle = album?.title ?? null;
  const year: string | null = album?.year != null ? String(album.year) : null;

  const [trackPos] = trackPosition(track, album);
  const version = track.version || track.metaData?.version || null;
  const genre = album?.genre || track.metaData?.genre || null;

  return {
    album: albumTitle || "",
    album_type: rawType || "",
    type_ru: albumTypeRu(rawType, trackCount) || "",
    year: year || "",
    labels: formatAllLabels(album?.labels),
    genre: (genre || "").trim(),
    track_number: trackPos,
    track_total: trackCount,
    version: (version || "").trim(),
    explicit: isExplicit(track),
    is_single: isSingle(rawType, trackCount),
    colors: derivedColors(track),
    album_id: album ? (album.id ?? null) : null,
    track_id: track.id ?? null,
    liked: null,
  };
}

/** yt-dlp даёт только opus/mp3/m4a на выходе — lossless не бывает. */
export type AudioQuality = "best" | "economy";

const ECONOMY_CAP_KBPS = 128;

/** выбор варианта загрузки по качеству. У Spotify пути один — всегда есть
 *  один DownloadInfo, поле quality влияет только на выбор yt-dlp формата
 *  (bestaudio vs. worstaudio bitrate). */
export function selectDownloadInfo<T extends { codec: string; bitrateInKbps: number }>(
  downloadInfos: T[] | null | undefined,
  quality: AudioQuality = "best",
): T | null {
  if (!downloadInfos || downloadInfos.length === 0) return null;
  const pickHighest = (pool: T[]): T =>
    pool.reduce((best, d) => (d.bitrateInKbps > best.bitrateInKbps ? d : best));
  if (quality === "economy") {
    const within = downloadInfos.filter((d) => d.bitrateInKbps <= ECONOMY_CAP_KBPS);
    if (within.length > 0) return pickHighest(within);
    return downloadInfos.reduce((lo, d) => (d.bitrateInKbps < lo.bitrateInKbps ? d : lo));
  }
  return pickHighest(downloadInfos);
}

export interface AlbumOverride {
  title?: string;
  year?: string;
  label?: string;
  genre?: string;
  track_number?: number;
  disc_number?: number;
  track_total?: number;
  disc_total?: number;
  cover_url?: string;
}

export function buildTrackMetadata(track: Track, albumOverride: AlbumOverride = {}): TrackMetadata {
  const o = albumOverride;
  const album = track.albums && track.albums.length > 0 ? track.albums[0]! : null;
  const meta = track.metaData ?? null;

  const artist = formatArtists(track.artists);
  const albumArtist = artist;
  const duration = Math.floor((track.durationMs || 0) / 1000);

  const albumTitle = firstTruthy(o.title, album?.title ?? null, meta?.album ?? null) || "";
  const year = firstTruthy(o.year, strOrEmpty(album?.year), strOrEmpty(meta?.year)) || "";
  const label = firstTruthy(o.label, formatLabel(album?.labels)) || "";
  const genre = firstTruthy(o.genre, album?.genre ?? null, meta?.genre ?? null) ?? null;

  const composer = meta?.composer ?? null;
  const version = firstTruthy(track.version ?? null, meta?.version ?? null) ?? null;
  const explicit = isExplicit(track);

  const [autoTrackNum, autoDiscNum] = trackPosition(track, album);
  const trackNumber = firstTruthy(o.track_number ?? null, autoTrackNum, meta?.number ?? null);
  const discNumber = firstTruthy(o.disc_number ?? null, autoDiscNum, meta?.volume ?? null);
  const trackTotal = firstTruthy(o.track_total ?? null, album?.trackCount ?? null);
  const discTotal = o.disc_total ?? null;

  const coverUrl =
    firstTruthy(
      o.cover_url,
      normalizeCoverUrl(album?.coverUri, "400x400"),
      normalizeCoverUrl(track.coverUri, "400x400"),
    ) || "";

  return {
    artist,
    album_artist: albumArtist,
    title: track.title || "Unknown",
    album: albumTitle,
    year,
    label,
    genre,
    composer,
    version,
    explicit,
    duration,
    track_number: trackNumber,
    track_total: trackTotal,
    disc_number: discNumber,
    disc_total: discTotal,
    cover_url: coverUrl,
    cover_data: null,
  };
}

/** дёргает полный Album если в track.albums[0] не хватает year/label/genre/count. */
export async function enrichMetadataFromAlbum(
  metadata: TrackMetadata,
  track: Track,
  client: AlbumShortProvider,
): Promise<TrackMetadata> {
  const albums = track.albums ?? [];
  if (albums.length === 0) return metadata;

  const need = !metadata.year || !metadata.label || !metadata.genre || !metadata.track_total;
  if (!need) return metadata;

  const albumId = albums[0]!.id ?? null;
  if (albumId === null) return metadata;

  const full = await client.getAlbumShort(albumId);
  if (!full) return metadata;

  if (!metadata.year && full.year) metadata.year = String(full.year);
  if (!metadata.label) metadata.label = formatLabel(full.labels);
  if (!metadata.genre && full.genre) metadata.genre = full.genre;
  if (!metadata.track_total && full.trackCount) metadata.track_total = full.trackCount;
  if (!metadata.cover_url && full.coverUri) metadata.cover_url = normalizeCoverUrl(full.coverUri, "400x400");

  return metadata;
}

/** Текст лирики → массив непустых обрезанных строк. Строки-заголовки секций
 *  целиком в скобках («[Куплет 1]») выкидываем — Genius их вставляет. */
export function splitLyricsLines(lyrics: string): string[] {
  return lyrics
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^\[.*\]$/.test(l));
}

export function bestLyricsLineIndex(query: string, lines: string[]): number {
  const q = query.toLowerCase().trim();
  if (lines.length === 0 || !q) return -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.toLowerCase().includes(q)) return i;
  }

  const qWords = new Set(q.split(/\s+/));
  const score = (line: string): number => {
    const lw = new Set(line.toLowerCase().split(/\s+/));
    let n = 0;
    for (const w of lw) if (qWords.has(w)) n++;
    return n;
  };
  let bestIdx = 0;
  let bestScore = score(lines[0]!);
  for (let i = 1; i < lines.length; i++) {
    const sc = score(lines[i]!);
    if (sc > bestScore) {
      bestIdx = i;
      bestScore = sc;
    }
  }
  return bestScore > 0 ? bestIdx : -1;
}

export function findBestLyricsLine(query: string, lyrics: string): string | null {
  const lines = splitLyricsLines(lyrics);
  const idx = bestLyricsLineIndex(query, lines);
  return idx >= 0 ? lines[idx]! : null;
}

/** Совместимость с бывшим wave-color-провайдером (яндексовским) — сейчас no-op,
 *  cardBuilder.enrichCardMetaColor всё равно его вызывает. */
export interface WaveColorProvider {
  getAlbumWaveColor(albumId: number | string): Promise<string | null>;
}

/** Совместимость: раньше подмешивал wave-цвет для ч/б обложек. У Spotify нет
 *  wave-агента, вся эта фича отсутствует. */
export async function enrichCardMetaColor(_meta: CardMeta, _client: WaveColorProvider): Promise<void> {
  // no-op — оставлен как хук для будущего своего экстрактора цвета обложки
}
