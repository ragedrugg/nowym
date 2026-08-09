/** Высокоуровневый клиент музыкального источника. Внутри — Spotify Web API
 *  для метаданных/поиска/лайков/плеера, yt-dlp — для реального аудио. */
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { removeTempFile, resolveAndDownload } from "../audio/ytdlp.ts";
import { sleep, withTimeout } from "../infra/async.ts";
import { HttpClient } from "../infra/http.ts";
import { getLogger } from "../infra/logging.ts";
import { LRUMap } from "../infra/lruMap.ts";
import { AsyncTokenGate } from "../infra/rateLimit.ts";
import { getSettings } from "../settings.ts";
import { normalizeCoverUrl } from "./media.ts";
import { type AudioQuality, bareTrackId, formatArtists } from "./metadata.ts";
import type { AlbumShortProvider, LikeProvider, WaveColorProvider } from "./metadata.ts";
import type { Album, AlbumData, Artist, DownloadInfo, Track } from "./types.ts";
import type { CurrentTrack } from "./watcher.ts";

const log = getLogger("music.client");

/** async () → новый access_token или null. */
export type RefreshCallback = () => Promise<string | null>;

const SPOTIFY_API = "https://api.spotify.com/v1";
const NP_CACHE_TTL_MS = 5_000;
const NP_FETCH_TIMEOUT_MS = 4_000;
const LIKES_CACHE_TTL_MS = 30_000;
// сколько API-вызовов подряд можно сделать без rate-задержки (интерактивный burst)
const RATE_BURST = 5;

/** Оставлено для совместимости — encraw был у Яндекс.Музыки (FLAC-CTR). Для
 *  Spotify + yt-dlp расшифровка не нужна. Всегда undefined. */
export function makeEncrawDecrypt(_key: string | null | undefined): ((data: Buffer) => Buffer) | undefined {
  return undefined;
}

class UnauthorizedError extends Error {}
class RateLimitError extends Error {
  constructor(public retryAfterMs: number) {
    super(`429 (retry after ${retryAfterMs}ms)`);
  }
}

interface SpotifyImage {
  url: string;
  width?: number;
  height?: number;
}

interface SpotifyArtist {
  id: string;
  name: string;
}

interface SpotifyAlbumMini {
  id: string;
  name: string;
  album_type?: string;
  release_date?: string;
  total_tracks?: number;
  images?: SpotifyImage[];
  artists?: SpotifyArtist[];
}

interface SpotifyAlbumFull extends SpotifyAlbumMini {
  copyrights?: Array<{ text?: string; type?: string }>;
  label?: string;
  genres?: string[];
  tracks?: { items: SpotifyTrack[]; next?: string | null };
}

interface SpotifyTrack {
  id: string;
  name: string;
  duration_ms: number;
  explicit: boolean;
  artists: SpotifyArtist[];
  album?: SpotifyAlbumMini;
  track_number?: number;
  disc_number?: number;
  external_ids?: { isrc?: string };
  is_playable?: boolean;
  available_markets?: string[];
}

interface SpotifyPlaylistMeta {
  id: string;
  name: string;
  images?: SpotifyImage[];
  tracks?: { total?: number };
  owner?: { id?: string; display_name?: string };
}

interface SpotifySearchResponse {
  tracks?: { items: SpotifyTrack[]; total: number; limit: number; offset: number };
  albums?: { items: SpotifyAlbumMini[]; total: number };
}

// ── маппинг Spotify → наши доменные типы ──────────────────────────────────

function pickCover(images: SpotifyImage[] | undefined): string {
  if (!images || images.length === 0) return "";
  // Spotify отдаёт по убыванию размера. Средний размер (300) хорош для карточки/тегов.
  const mid = images.find((i) => (i.width ?? 0) >= 300 && (i.width ?? 0) <= 640);
  return mid?.url || images[0]!.url;
}

function mapArtists(list: SpotifyArtist[] | undefined): Artist[] {
  return (list ?? []).map((a) => ({ id: a.id, name: a.name }));
}

function yearFromReleaseDate(rd: string | undefined): string {
  if (!rd) return "";
  const m = /^(\d{4})/.exec(rd);
  return m ? m[1]! : "";
}

function mapAlbumMini(a: SpotifyAlbumMini | undefined): Album | null {
  if (!a) return null;
  return {
    id: a.id,
    title: a.name,
    year: yearFromReleaseDate(a.release_date),
    trackCount: a.total_tracks ?? null,
    type: a.album_type ?? null,
    coverUri: pickCover(a.images),
    artists: mapArtists(a.artists),
    available: true,
  };
}

function mapAlbumFull(a: SpotifyAlbumFull): Album {
  const mini = mapAlbumMini(a)!;
  const labels = a.label ? [a.label] : (a.copyrights ?? []).map((c) => c.text ?? "").filter(Boolean);
  const genre = a.genres && a.genres.length > 0 ? a.genres[0]! : null;
  return { ...mini, labels, genre };
}

function mapTrack(t: SpotifyTrack): Track {
  return {
    id: t.id,
    title: t.name,
    available: t.is_playable ?? true,
    durationMs: t.duration_ms,
    explicit: t.explicit,
    contentWarning: t.explicit ? "explicit" : null,
    artists: mapArtists(t.artists),
    albums: t.album ? [mapAlbumMini(t.album)!] : [],
    coverUri: pickCover(t.album?.images),
    isrc: t.external_ids?.isrc ?? null,
    trackPosition: {
      index: t.track_number ?? null,
      volume: t.disc_number ?? null,
    },
  };
}

// ── клиент ────────────────────────────────────────────────────────────────

export class MusicClient implements WaveColorProvider, LikeProvider, AlbumShortProvider {
  private token: string;
  private readonly http = new HttpClient();
  private readonly gate: AsyncTokenGate;
  private readonly maxRetries: number;
  private readonly refreshCb: RefreshCallback | null;

  // дедуп параллельных get_current_track
  private npInflight: Promise<CurrentTrack> | null = null;
  private npCache: CurrentTrack | null = null;
  private npCacheAt = 0;
  // кэш set лайкнутых трек-id с TTL
  private likesCache: Set<string> | null = null;
  private likesCacheAt = 0;
  // кэш готовых yt-dlp DownloadInfo (файл уже на диске) — трек ID → info.
  // Освобождается TTL-sweeper'ом ytdlp.ts (файл удаляется через 15 мин).
  private downloadInfoCache = new LRUMap<string, DownloadInfo>(200);

  constructor(token: string, refreshCallback: RefreshCallback | null = null) {
    if (!token || typeof token !== "string") throw new Error("токен должен быть непустой строкой");
    this.token = token;
    const s = getSettings();
    this.gate = new AsyncTokenGate(RATE_BURST, s.SPOTIFY_RATE_LIMIT_INTERVAL * 1000);
    this.maxRetries = s.SPOTIFY_MAX_RETRIES;
    this.refreshCb = refreshCallback;
  }

  /** явная инициализация — валидация токена через /me. */
  async init(): Promise<void> {
    await this.spotifyFetch("/me");
  }

  private async spotifyFetch<T = unknown>(
    pathOrUrl: string,
    opts: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown } = {},
  ): Promise<T> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${SPOTIFY_API}${pathOrUrl}`;
    const res = await this.http.request(url, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (res.status === 401) {
      await res.body.dump();
      throw new UnauthorizedError("Spotify 401");
    }
    if (res.status === 429) {
      const retry = parseInt(String(res.headers["retry-after"] ?? "1"), 10);
      await res.body.dump();
      throw new RateLimitError(Math.max(retry, 1) * 1000);
    }
    if (res.status === 204 || res.status === 202) {
      await res.body.dump();
      return {} as T;
    }
    if (res.status >= 400) {
      const text = await res.body.text().catch(() => "");
      throw new Error(`Spotify HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (opts.method === "PUT" || opts.method === "DELETE") {
      await res.body.dump();
      return {} as T;
    }
    return (await res.body.json()) as T;
  }

  private async tryRefreshToken(): Promise<boolean> {
    if (this.refreshCb === null) return false;
    let newToken: string | null;
    try {
      newToken = await this.refreshCb();
    } catch (e) {
      log.warning(`refresh_callback бросил: ${e}`);
      return false;
    }
    if (!newToken) return false;
    this.token = newToken;
    log.info("токен обновлён реактивно после 401");
    return true;
  }

  private async withRetry<T>(func: () => Promise<T>, baseDelayMs = 2000): Promise<T> {
    let lastError: unknown = null;
    let refreshTried = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.gate.acquire();
        return await func();
      } catch (e) {
        if (e instanceof UnauthorizedError && !refreshTried) {
          lastError = e;
          if (await this.tryRefreshToken()) {
            refreshTried = true;
            continue;
          }
          throw e;
        }
        if (e instanceof RateLimitError && attempt < this.maxRetries) {
          const delay = e.retryAfterMs + Math.random() * 500;
          log.warning(`rate limit, попытка ${attempt + 1}/${this.maxRetries + 1}, ждём ${(delay / 1000).toFixed(1)}с`);
          await sleep(delay);
          lastError = e;
        } else {
          throw e;
        }
      }
    }
    throw new Error(`превышено число попыток: ${lastError}`);
  }

  private async withApi<T>(
    label: string,
    fallback: T,
    func: () => Promise<T>,
    level: "error" | "warning" = "error",
  ): Promise<T> {
    try {
      return await this.withRetry(func);
    } catch (e) {
      log[level](`ошибка ${label}: ${e}`);
      return fallback;
    }
  }

  async getTrackById(trackId: number | string): Promise<Track | null> {
    return this.withApi(`getTrackById(${trackId})`, null, async () => {
      const t = await this.spotifyFetch<SpotifyTrack>(`/tracks/${bareTrackId(trackId)}`);
      return mapTrack(t);
    });
  }

  async searchTracks(query: string, limit?: number): Promise<Track[]> {
    const lim = limit ?? getSettings().MAX_SEARCH_RESULTS;
    return this.withApi(`searchTracks(${JSON.stringify(query)})`, [], async () => {
      const r = await this.spotifyFetch<SpotifySearchResponse>(
        `/search?q=${encodeURIComponent(query)}&type=track&limit=${lim}`,
      );
      return (r.tracks?.items ?? []).map(mapTrack);
    });
  }

  /** пагинация: Spotify limit=50 max, offset — сдвиг от начала. */
  async searchTracksPage(
    query: string,
    page = 0,
  ): Promise<{ tracks: Track[]; total: number; perPage: number }> {
    const perPage = 20;
    const offset = page * perPage;
    return this.withApi(
      `searchTracksPage(${JSON.stringify(query)}, ${page})`,
      { tracks: [], total: 0, perPage: 0 },
      async () => {
        const r = await this.spotifyFetch<SpotifySearchResponse>(
          `/search?q=${encodeURIComponent(query)}&type=track&limit=${perPage}&offset=${offset}`,
        );
        return {
          tracks: (r.tracks?.items ?? []).map(mapTrack),
          total: r.tracks?.total ?? 0,
          perPage,
        };
      },
    );
  }

  /** У Spotify нет suggest — всегда null (проверка проглатывается вызывающим). */
  async suggestCorrection(_query: string): Promise<string | null> {
    return null;
  }

  async getAlbumShort(albumId: number | string): Promise<Album | null> {
    return this.withApi(`getAlbumShort(${albumId})`, null, async () => {
      const a = await this.spotifyFetch<SpotifyAlbumFull>(`/albums/${bareTrackId(albumId)}`);
      return mapAlbumFull(a);
    });
  }

  /** Совместимость — у Spotify своего wave-цвета нет. */
  async getAlbumWaveColor(_albumId: number | string): Promise<string | null> {
    return null;
  }

  async getLikedTrackIds(): Promise<Set<string>> {
    const now = performance.now();
    if (this.likesCache !== null && now - this.likesCacheAt < LIKES_CACHE_TTL_MS) {
      return this.likesCache;
    }
    // Spotify: /me/tracks — постраничный список сохранённых.
    // Тянем первые 200 (достаточно для лайк-статуса свежих треков; полная
    // библиотека может быть тысячи, но она не нужна для локальной проверки —
    // фолбэк через /me/tracks/contains ниже).
    try {
      const ids = new Set<string>();
      let url: string | null = "/me/tracks?limit=50";
      let pages = 0;
      while (url && pages < 4) {
        const r: { items?: Array<{ track?: { id?: string } }>; next?: string | null } =
          await this.withRetry(() =>
            this.spotifyFetch<{ items?: Array<{ track?: { id?: string } }>; next?: string | null }>(url!),
          );
        for (const item of r.items ?? []) {
          if (item.track?.id) ids.add(item.track.id);
        }
        url = r.next ?? null;
        pages++;
      }
      this.likesCache = ids;
      this.likesCacheAt = now;
      return ids;
    } catch (e) {
      log.debug(`usersLikesTracks: ${e}`);
      return this.likesCache ?? new Set();
    }
  }

  async isTrackLiked(trackId: number | string): Promise<boolean> {
    const id = bareTrackId(trackId);
    // Локальная проверка по кэшу — быстро для «свежих» треков.
    if (this.likesCache !== null) return this.likesCache.has(id);
    // Точечно — /me/tracks/contains?ids=<id>.
    try {
      const r = await this.withRetry(() => this.spotifyFetch<boolean[]>(`/me/tracks/contains?ids=${id}`));
      return r[0] ?? false;
    } catch (e) {
      log.debug(`isTrackLiked(${id}): ${e}`);
      return false;
    }
  }

  async setTrackLiked(trackId: number | string, liked: boolean): Promise<boolean> {
    const id = bareTrackId(trackId);
    try {
      await this.withRetry(() =>
        this.spotifyFetch(`/me/tracks?ids=${id}`, { method: liked ? "PUT" : "DELETE" }),
      );
      if (this.likesCache !== null) {
        if (liked) this.likesCache.add(id);
        else this.likesCache.delete(id);
      }
      return true;
    } catch (e) {
      log.warning(`setTrackLiked(${id}, ${liked}): ${e}`);
      return false;
    }
  }

  /** Spotify не даёт api-эндпоинта «зачесть прослушивание» без активного
   *  устройства. Оставлено no-op — Spotify сам двигает статистику, когда трек
   *  проигрывается в клиенте, а не в боте. */
  async reportPlayback(_track: Track): Promise<void> {
    // no-op
  }

  async getRecentTracks(limit = 12): Promise<Track[]> {
    return this.withApi(`getRecentTracks(${limit})`, [], async () => {
      const r = await this.spotifyFetch<{ items: Array<{ track: SpotifyTrack }> }>(
        `/me/player/recently-played?limit=${Math.min(limit, 50)}`,
      );
      // Дедуп по id — recently-played часто повторяет один и тот же трек за сессию.
      const seen = new Set<string>();
      const out: Track[] = [];
      for (const item of r.items ?? []) {
        const t = item.track;
        if (!t || seen.has(t.id)) continue;
        seen.add(t.id);
        out.push(mapTrack(t));
        if (out.length >= limit) break;
      }
      return out;
    });
  }

  /** Spotify не даёт api к тексту песни. Genius (в services) остаётся основным
   *  источником для лирики; тут всегда null — вызывающая сторона знает. */
  async getTrackLyrics(_trackId: number | string): Promise<string | null> {
    return null;
  }

  async getTrackLRC(_trackId: number | string): Promise<string | null> {
    return null;
  }

  async searchAlbums(query: string, limit = 3): Promise<Album[]> {
    return this.withApi(`searchAlbums(${JSON.stringify(query)})`, [], async () => {
      const r = await this.spotifyFetch<SpotifySearchResponse>(
        `/search?q=${encodeURIComponent(query)}&type=album&limit=${limit}`,
      );
      return (r.albums?.items ?? []).map((a) => mapAlbumMini(a)!).filter((a) => a !== null);
    });
  }

  async getCurrentTrack(): Promise<CurrentTrack> {
    const now = performance.now();
    if (this.npCache !== null && now - this.npCacheAt < NP_CACHE_TTL_MS) return this.npCache;
    if (this.npInflight !== null) return this.npInflight;

    const fetch = async (): Promise<CurrentTrack> => {
      return withTimeout(this.fetchCurrentlyPlaying(), NP_FETCH_TIMEOUT_MS, "now-playing");
    };
    this.npInflight = fetch();
    try {
      const result = await this.npInflight;
      this.npCache = result;
      this.npCacheAt = performance.now();
      return result;
    } finally {
      this.npInflight = null;
    }
  }

  private async fetchCurrentlyPlaying(): Promise<CurrentTrack> {
    return this.withRetry(async () => {
      const r = await this.spotifyFetch<{
        is_playing?: boolean;
        progress_ms?: number;
        item?: SpotifyTrack | null;
        context?: { uri?: string; type?: string };
      } | null>("/me/player/currently-playing");
      if (!r || !r.item) {
        return {
          track: null,
          paused: true,
          duration_ms: 0,
          progress_ms: 0,
          entity_id: null,
          entity_type: null,
        };
      }
      return {
        track: mapTrack(r.item),
        paused: !r.is_playing,
        duration_ms: r.item.duration_ms,
        progress_ms: r.progress_ms ?? 0,
        entity_id: r.context?.uri ?? null,
        entity_type: r.context?.type ?? null,
      };
    });
  }

  /** «Готовит» аудио к отдаче: yt-dlp резолвит трек, скачивает в temp файл.
   *  Возвращает DownloadInfo, у которого downloadInfoUrl = file://<путь>. */
  async getBestDownloadInfo(track: Track, quality: AudioQuality = "best"): Promise<DownloadInfo | null> {
    if (!track.id) return null;
    const cacheKey = `${track.id}:${quality}`;
    const cached = this.downloadInfoCache.get(cacheKey);
    if (cached) return cached;

    const artist = formatArtists(track.artists);
    const title = (track.title ?? "").trim();
    const resolved = await resolveAndDownload({
      id: bareTrackId(track.id),
      artist,
      title,
      durationSec: track.durationMs ? Math.round(track.durationMs / 1000) : null,
      isrc: track.isrc ?? null,
      quality,
    });
    if (!resolved) return null;
    const info: DownloadInfo = {
      codec: normalizeCodec(resolved.codec),
      bitrateInKbps: resolved.bitrateKbps,
      downloadInfoUrl: pathToFileURL(resolved.filePath).href,
      direct: true,
    };
    this.downloadInfoCache.set(cacheKey, info);
    return info;
  }

  /** Совместимость: раньше lossless шёл отдельным путём (FLAC + CTR). Через
   *  yt-dlp его нет — фолбэк на best-качество. */
  async getLosslessDownload(_track: Track): Promise<null> {
    return null;
  }

  async getDownloadUrl(track: Track, quality: AudioQuality = "best"): Promise<string | null> {
    const info = await this.getBestDownloadInfo(track, quality);
    return info ? info.downloadInfoUrl : null;
  }

  /** Для yt-dlp сcылка не «протухает» — файл уже на диске. Возвращает как есть. */
  async directLinkFromInfo(info: DownloadInfo): Promise<string | null> {
    return info.downloadInfoUrl ?? null;
  }

  /** Полный альбом с треками. Проставляет _trackNumber/_discNumber. */
  async getAlbum(albumId: number | string): Promise<AlbumData | null> {
    const id = bareTrackId(albumId);
    const albumRaw = await this.withApi(`getAlbum(${id})`, null as SpotifyAlbumFull | null, async () => {
      return this.spotifyFetch<SpotifyAlbumFull>(`/albums/${id}`);
    });
    if (!albumRaw) return null;

    // Догружаем оставшиеся страницы треков (limit=50).
    const tracks: SpotifyTrack[] = [...(albumRaw.tracks?.items ?? [])];
    let next = albumRaw.tracks?.next ?? null;
    while (next) {
      try {
        const r = await this.spotifyFetch<{ items: SpotifyTrack[]; next?: string | null }>(next);
        tracks.push(...r.items);
        next = r.next ?? null;
      } catch (e) {
        log.warning(`догрузка треков альбома ${id}: ${e}`);
        break;
      }
    }

    const album = mapAlbumFull(albumRaw);
    const mapped: Track[] = [];
    const volumesMap = new Map<number, Track[]>();
    for (const st of tracks) {
      const t = mapTrack({ ...st, album: albumRaw });
      const discIdx = st.disc_number ?? 1;
      const trackIdx = st.track_number ?? mapped.length + 1;
      t._trackNumber = trackIdx;
      t._discNumber = discIdx;
      mapped.push(t);
      if (!volumesMap.has(discIdx)) volumesMap.set(discIdx, []);
      volumesMap.get(discIdx)!.push(t);
    }
    if (mapped.length === 0) {
      log.warning(`альбом ${id}: пустой список треков`);
      return null;
    }

    const volumes = [...volumesMap.keys()].sort((a, b) => a - b).map((k) => volumesMap.get(k)!);
    const artist = formatArtists(album.artists);
    const year = album.year ? String(album.year) : "";
    const labelStr = album.labels && album.labels.length > 0
      ? typeof album.labels[0] === "string"
        ? album.labels[0]!
        : (album.labels[0]!.name ?? "")
      : "";
    const genre = album.genre || "";
    const coverUrl = normalizeCoverUrl(album.coverUri || "", "orig");

    log.info(`альбом ${id}: «${album.title}» ${artist} [${year}], ${mapped.length} треков`);

    return {
      id,
      title: album.title || "",
      artist,
      year,
      label: labelStr,
      cover_url: coverUrl,
      genre,
      album_type: album.type || "",
      tracks: mapped,
      volumes,
    };
  }

  /** Шапка плейлиста — /playlists/{id} с полями только шапки. */
  async getPlaylistShort(
    _owner: string,
    kind: string | number,
  ): Promise<{ title: string; coverUri: string; trackCount: number } | null> {
    const id = bareTrackId(kind);
    return this.withApi(`getPlaylistShort(${id})`, null, async () => {
      const p = await this.spotifyFetch<SpotifyPlaylistMeta>(
        `/playlists/${id}?fields=id,name,images,tracks.total`,
      );
      return {
        title: p.name || "",
        coverUri: pickCover(p.images),
        trackCount: p.tracks?.total ?? 0,
      };
    });
  }

  /** Плейлист как AlbumData — переиспользует всю инфру AlbumService. */
  async getPlaylist(_owner: string, kind: string | number): Promise<AlbumData | null> {
    const id = bareTrackId(kind);
    const meta = await this.withApi(`getPlaylist(${id})`, null as SpotifyPlaylistMeta | null, async () => {
      return this.spotifyFetch<SpotifyPlaylistMeta>(`/playlists/${id}?fields=id,name,images,tracks.total`);
    });
    if (!meta) return null;

    // Тянем треки постранично (100 max за раз).
    const tracks: SpotifyTrack[] = [];
    let next: string | null = `/playlists/${id}/tracks?limit=100&fields=items(track(id,name,duration_ms,explicit,artists,album(id,name,release_date,images,total_tracks,album_type,artists),track_number,disc_number,external_ids,is_playable)),next`;
    while (next) {
      try {
        const r: { items: Array<{ track: SpotifyTrack | null }>; next?: string | null } = await this.spotifyFetch(next);
        for (const item of r.items ?? []) {
          if (item.track) tracks.push(item.track);
        }
        next = r.next ?? null;
      } catch (e) {
        log.warning(`догрузка треков плейлиста ${id}: ${e}`);
        break;
      }
    }
    return buildPlaylistAlbumData(id, meta.name || "", pickCover(meta.images), tracks.map(mapTrack));
  }

  async close(): Promise<void> {
    await this.http.close();
    for (const [, info] of this.downloadInfoCache.entries()) {
      void removeTempFile(pathFromFileUrl(info.downloadInfoUrl)).catch(() => {});
    }
  }
}

function pathFromFileUrl(url: string): string {
  if (!url.startsWith("file://")) return "";
  return decodeURIComponent(url.slice("file://".length));
}

function normalizeCodec(raw: string): string {
  const c = raw.toLowerCase();
  if (c.includes("opus")) return "opus";
  if (c.includes("mp3")) return "mp3";
  if (c.includes("aac") || c.includes("mp4a")) return "aac";
  if (c.includes("m4a")) return "aac";
  return c || "opus";
}

export function buildPlaylistAlbumData(
  kind: string,
  title: string,
  coverUri: string,
  tracks: Track[],
): AlbumData | null {
  const available = tracks.filter((t) => t && t.available !== false);
  if (available.length === 0) return null;
  available.forEach((t, i) => {
    t._trackNumber = i + 1;
    t._discNumber = 1;
  });
  return {
    id: kind,
    title,
    artist: "Плейлист",
    year: "",
    label: "",
    cover_url: coverUri ? normalizeCoverUrl(coverUri, "orig") : "",
    genre: "",
    album_type: "playlist",
    tracks: available,
    volumes: [available],
  };
}

export class MusicClientFactory {
  static async create(token: string, refreshCallback: RefreshCallback | null = null): Promise<MusicClient> {
    const client = new MusicClient(token, refreshCallback);
    await client.init();
    return client;
  }
}
