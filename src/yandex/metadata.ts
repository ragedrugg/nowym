/** TrackMetadata / CardMeta из сырых объектов Yandex.
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
  CardColors,
  CardMeta,
  TrackMetadata,
  YaAlbum,
  YaArtist,
  YaLabel,
  YaTrack,
  YaTrackPosition,
} from "./types.ts";

// self-hosted Bot API (лимит файла 2гб) → длинные треки допустимы. Потолок 4.5ч.
const MAX_TRACK_DURATION_MS = 4.5 * 60 * 60 * 1000;

// потолок размера файла: качаем+тегируем в RAM (двойной буфер) при 7.8гб всего на машине.
// >1.2гб → отказ ДО скачивания, иначе OOM-kill процесса (pm2 max_memory_restart).
export const MAX_TRACK_BYTES = 1.2 * 1024 ** 3;
// >200мб → «тяжёлый»: строго по одному (heavyLock) + без racing-параллелизма (solo-качка).
export const HEAVY_TRACK_BYTES = 200 * 1024 ** 2;

const FALLBACK_KBPS: Record<string, number> = { flac: 1100, "flac-mp4": 1100, aac: 256, mp3: 320 };

/** оценка размера файла по длительности+битрейту (до скачивания). 0 при неизвестной длительности. */
export function estimateTrackBytes(durationSec: number, bitrateKbps?: number | null, codec?: string | null): number {
  if (!durationSec || durationSec <= 0) return 0;
  const codecKey = codec ?? "mp3";
  const fallbackKbps = Object.hasOwn(FALLBACK_KBPS, codecKey) ? FALLBACK_KBPS[codecKey] : undefined;
  const kbps = bitrateKbps && bitrateKbps > 0 ? bitrateKbps : (fallbackKbps ?? 320);
  return Math.round(durationSec * kbps * 125 * 1.1); // *125 = *1000/8; *1.1 — запас на контейнер
}

// минимальные интерфейсы клиента — чтобы metadata не зависела от client.ts
export interface WaveColorProvider {
  getAlbumWaveColor(albumId: number): Promise<string | null>;
}
export interface LikeProvider {
  isTrackLiked(trackId: number | string): Promise<boolean>;
}
export interface AlbumShortProvider {
  getAlbumShort(albumId: number | string): Promise<YaAlbum | null>;
}

export function trackIsTooLong(track: YaTrack): boolean {
  const ms = track.durationMs;
  if (!ms) return false; // неизвестно — пропускаем, реальный send ответит сам
  return ms > MAX_TRACK_DURATION_MS;
}

/** ms → '30:45' / '1:23:45'. */
export function formatDurationHuman(durationMs: number | null | undefined): string {
  const s = Math.max(0, Math.floor((durationMs || 0) / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s >= 3600) return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** "123:456" | 123 → "123" (отбрасываем album-часть составного trackId). */
export function bareTrackId(id: number | string | null | undefined): string {
  return String(id).split(":")[0]!;
}

/** артисты → «Имя, Имя». default если список пуст или у всех нет name. */
export function formatArtists(artists: YaArtist[] | null | undefined, def = "Unknown"): string {
  if (!artists || artists.length === 0) return def;
  const names = artists.map((a) => a.name).filter((n): n is string => Boolean(n));
  return names.length > 0 ? names.join(", ") : def;
}

/** (artist, title) из Track-объекта, без enrichment. */
export function formatTrackBasics(track: YaTrack, defaultTitle = "—"): [string, string] {
  const artist = formatArtists(track.artists);
  const title = (track.title || defaultTitle).trim() || defaultTitle;
  return [artist, title];
}

/** Album.labels — [{name}] или [string]. берём первый (для TrackMetadata/тегов). */
function formatLabel(labels: YaLabel[] | null | undefined): string {
  if (!labels || labels.length === 0) return "";
  const first = labels[0]!;
  if (typeof first === "string") return first;
  return first.name ? first.name : String(first);
}

/** Все лейблы альбома в виде массива строк (для CardMeta.labels / ℗-строки). */
function formatAllLabels(labels: YaLabel[] | null | undefined): string[] {
  if (!labels || labels.length === 0) return [];
  return labels.map((l) => (typeof l === "string" ? l : (l.name ?? "")).trim()).filter(Boolean);
}

function strOrEmpty(v: unknown): string {
  return v ? String(v) : "";
}

/** первое значение не из (null/undefined/""/0). */
function firstTruthy<T>(...values: T[]): T | null {
  for (const v of values) {
    if (v !== null && v !== undefined && (v as unknown) !== "" && (v as unknown) !== 0) return v;
  }
  return null;
}

/** трек с нецензурной лексикой. источник — content_warning='explicit';
 * itunes-флаг explicit берём фолбэком. */
function isExplicit(track: YaTrack): boolean {
  return !!(track.contentWarning || track.explicit);
}

const ALBUM_TYPE_RU: Record<string, string> = {
  single: "сингл",
  ep: "EP",
  album: "альбом",
  compilation: "сборник",
  podcast: "подкаст",
  audiobook: "аудиокнига",
  remix: "ремикс",
  live: "концерт",
  soundtrack: "саундтрек",
};

/** тип релиза → ru-ярлык. fallback по trackCount. */
export function albumTypeRu(
  albumType: string | null | undefined,
  trackCount: number | null | undefined = null,
): string | null {
  if (albumType) {
    const key = albumType.toLowerCase();
    // Object.hasOwn, а не `in` — `in` проверяет и цепочку прототипов
    // (albumType === "toString" иначе давал бы Function вместо string)
    if (Object.hasOwn(ALBUM_TYPE_RU, key)) return ALBUM_TYPE_RU[key]!;
  }
  if (trackCount === null || trackCount === undefined) return null;
  if (trackCount === 1) return "сингл";
  if (trackCount >= 2 && trackCount <= 6) return "EP";
  if (trackCount > 6) return "альбом";
  return null;
}

const ALBUM_TYPE_EMOJI: Record<string, string> = {
  podcast: "🎙️",
  audiobook: "🎧",
  playlist: "🎵",
};

/** эмодзи-маркер релиза для заголовков выгрузки: подкаст/аудиокнига получают
 * свой значок вместо дефолтного «пластинки», остальные типы — как обычный альбом. */
export function albumEmoji(albumType: string | null | undefined): string {
  return (albumType && ALBUM_TYPE_EMOJI[albumType.toLowerCase()]) || "📀";
}

/** типы, для которых в meta-строке выгрузки явно показываем ru-ярлык: обычный
 * альбом и так узнаётся по 📀, а подкаст/аудиокнигу стоит подписать явно. */
export const LABELED_ALBUM_TYPES = new Set(["podcast", "audiobook"]);

/** для сингла album.title часто == track.title → дубль на карточке. */
export function isSingle(albumType: string | null | undefined, trackCount: number | null | undefined = null): boolean {
  if (albumType && albumType.toLowerCase() === "single") return true;
  return trackCount === 1;
}

/** hex-цвета обложки от я.музыки (track.derivedColors). */
function derivedColors(track: YaTrack): CardColors {
  const dc = track.derivedColors;
  if (!dc) return {};
  return {
    accent: dc.accent || "",
    average: dc.average || "",
    wave_text: dc.waveText || "",
  };
}

/** (trackNumber, discNumber) из trackPosition. пробуем album, потом track. */
function trackPosition(track: YaTrack, album: YaAlbum | null): [number | null, number | null] {
  for (const src of [album, track] as Array<{ trackPosition?: YaTrackPosition | null } | null>) {
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
export function buildCardMeta(track: YaTrack): CardMeta {
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
    liked: null, // лайк-статус на карточке не показывается (см. bot/cardBuilder.ts) — не заполняется
  };
}

/** hex-цвет wave-агента из Lottie-иконки «Моей волны». на любой кривизне → null. */
export function waveColorFromLottie(data: Buffer): string | null {
  let doc: { layers?: Array<{ nm?: string; shapes?: Array<{ it?: Array<{ ty?: string; c?: { k?: unknown } }> }> }> };
  try {
    doc = JSON.parse(data.toString("utf-8"));
  } catch {
    return null;
  }
  for (const layer of doc.layers ?? []) {
    if (layer.nm !== "color") continue;
    for (const shape of layer.shapes ?? []) {
      for (const it of shape.it ?? []) {
        if (it.ty !== "fl") continue;
        const k = it.c?.k;
        if (Array.isArray(k) && k.length >= 3) {
          const [r, g, b] = k.slice(0, 3).map((x) => Math.max(0, Math.min(255, Math.round(Number(x) * 255))));
          // нечисловой компонент → NaN.toString(16) === "NaN", а результат
          // кэшируется на весь процесс (client.ts) — лучше вообще не найти цвет
          if (![r, g, b].every(Number.isFinite)) return null;
          const hex = (n: number) => n.toString(16).padStart(2, "0");
          return `#${hex(r!)}${hex(g!)}${hex(b!)}`;
        }
      }
    }
  }
  return null;
}

/** True, если derived_colors ахроматичны (ч/б обложка) → стоит тянуть wave-цвет.
 * wave идёт в meta.colors.wave и используется extractAccent ЛИШЬ как фолбэк для
 * реально ч/б обложек (ноль насыщенных пикселей) — цветную обложку он не перебьёт. */
export function metaNeedsWaveColor(meta: CardMeta): boolean {
  const colors = meta.colors || {};
  if (colors.wave) return false; // уже подтянут
  if (!meta.album_id) return false;
  const h = (colors.accent || "").replace(/^#/, "");
  if (h.length !== 6) return true; // цвета нет вовсе
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return true;
  return Math.max(r, g, b) - Math.min(r, g, b) < 26; // ~серый
}

/** ч/б обложка → подмешивает в meta.colors.wave кураторский цвет wave-агента. */
export async function enrichCardMetaColor(meta: CardMeta, client: WaveColorProvider): Promise<void> {
  if (!metaNeedsWaveColor(meta)) return;
  let wave: string | null = null;
  try {
    wave = await client.getAlbumWaveColor(meta.album_id!);
  } catch {
    return;
  }
  if (wave) meta.colors = { ...meta.colors, wave };
}

/** порог экономии: лучший вариант с битрейтом ≤ ECONOMY_CAP_KBPS. */
const ECONOMY_CAP_KBPS = 192;
// "lossless" обслуживается отдельным путём (get-file-info + AES-CTR), а не
// selectDownloadInfo — здесь он трактуется как best (фолбэк mp3/aac).
export type AudioQuality = "best" | "economy" | "lossless";

/** выбор варианта загрузки по качеству среди mp3/aac (аналог get_specific_download_info
 * из python-либы, но по тиру битрейта — lossless/FLAC этот endpoint не отдаёт).
 * best — макс. битрейт (при равном предпочтение mp3); economy — лучший ≤192
 * (или самый низкий, если все варианты выше порога). */
export function selectDownloadInfo<T extends { codec: string; bitrateInKbps: number }>(
  downloadInfos: T[] | null | undefined,
  quality: AudioQuality = "best",
): T | null {
  if (!downloadInfos || downloadInfos.length === 0) return null;
  let candidates = downloadInfos.filter((d) => d.codec === "mp3" || d.codec === "aac");
  if (candidates.length === 0) candidates = [...downloadInfos];
  const pickHighest = (pool: T[]): T =>
    pool.reduce((best, d) => {
      const score = (x: T): [number, number] => [x.bitrateInKbps, x.codec === "mp3" ? 1 : 0];
      const [b0, b1] = score(best);
      const [d0, d1] = score(d);
      return d0 > b0 || (d0 === b0 && d1 > b1) ? d : best;
    });
  if (quality === "economy") {
    const within = candidates.filter((d) => d.bitrateInKbps <= ECONOMY_CAP_KBPS);
    if (within.length > 0) return pickHighest(within);
    return candidates.reduce((lo, d) => (d.bitrateInKbps < lo.bitrateInKbps ? d : lo));
  }
  return pickHighest(candidates);
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

export function buildTrackMetadata(track: YaTrack, albumOverride: AlbumOverride = {}): TrackMetadata {
  const o = albumOverride;
  const album = track.albums && track.albums.length > 0 ? track.albums[0]! : null;
  const meta = track.metaData ?? null;

  const artist = formatArtists(track.artists);
  const albumArtist = artist; // яндекс не разделяет
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
  track: YaTrack,
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

/** Текст лирики → массив непустых обрезанных строк (порядок песни сохранён).
 * Строки-заголовки секций целиком в скобках («[Куплет 1]», «[Припев]» —
 * Genius их вставляет) выкидываем: на карточке это шум. */
export function splitLyricsLines(lyrics: string): string[] {
  return lyrics
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^\[.*\]$/.test(l));
}

/** Индекс строки, лучше всего совпадающей с query: сначала подстрока, затем по
 * пересечению слов. -1 — совпадения нет. lines уже разбиты splitLyricsLines. */
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
