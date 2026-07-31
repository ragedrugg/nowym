/** Высокоуровневый клиент Yandex Music: кэши, retry, rate-limit, refresh.
 * Поверх @dvxch/yandex-music (каталог/лайки/ynison/download). */
import { performance } from "node:perf_hooks";
import { getLogger } from "../infra/logging.ts";
import { sleep, withTimeout } from "../infra/async.ts";
import { LRUMap } from "../infra/lruMap.ts";
import { AsyncTokenGate } from "../infra/rateLimit.ts";
import { getSettings } from "../settings.ts";
import {
  bareTrackId,
  formatArtists,
  selectDownloadInfo,
  type AudioQuality,
  waveColorFromLottie,
} from "./metadata.ts";
import { normalizeCoverUrl } from "./media.ts";
import type { AlbumShortProvider, LikeProvider, WaveColorProvider } from "./metadata.ts";
import { isLrc } from "./lrc.ts";
import type { AlbumData, DownloadInfo, YaAlbum, YaTrack } from "./types.ts";
import { YnisonService, type CurrentTrack } from "./ynison.ts";
import {
  Client as LibClient,
  NetworkError as LibNetworkError,
  NotFoundError as LibNotFoundError,
  UnauthorizedError as LibUnauthorizedError,
  DownloadInfo as LibDownloadInfo,
  LosslessDownloadInfo as LibLosslessDownloadInfo,
  decryptEncraw,
} from "@dvxch/yandex-music";

const log = getLogger("yandex.client");

/** Фабрика расшифровщика encraw-потока (FLAC) по hex-ключу из get-file-info, или
 * undefined для незашифрованных. */
export function makeEncrawDecrypt(key: string | null | undefined): ((data: Buffer) => Buffer) | undefined {
  if (!key) return undefined;
  return (data: Buffer): Buffer => Buffer.from(decryptEncraw(data, key));
}

/** async () → новый access_token или null. */
export type RefreshCallback = () => Promise<string | null>;

const CLIENT_INIT_TIMEOUT = 9_000;
const NP_CACHE_TTL_MS = 5_000;
const NP_FETCH_TIMEOUT_MS = 4_000;
const LIKES_CACHE_TTL_MS = 30_000;
// сколько API-вызовов подряд можно сделать без rate-задержки (интерактивный burst)
const RATE_BURST = 5;

export class YandexClient implements WaveColorProvider, LikeProvider, AlbumShortProvider {
  private token: string;
  // библиотечный клиент @dvxch/yandex-music — единый транспорт (каталог/лайки/
  // ynison/download/lyrics/history/landing).
  private lib: LibClient | null = null;
  private ynison: YnisonService | null = null;

  // token-bucket: burst мгновенных вызовов + долив 1/minInterval. Интерактивные
  // потоки не платят rate-задержку, массовые (альбом) спейсятся; 429 страхует withRetry.
  private readonly gate: AsyncTokenGate;
  private readonly maxRetries: number;
  private readonly refreshCb: RefreshCallback | null;

  // дедуп параллельных get_current_track
  private npInflight: Promise<CurrentTrack> | null = null;
  private npCache: CurrentTrack | null = null;
  private npCacheAt = 0;
  // кэш кураторских wave-цветов по album_id
  private waveColorCache = new LRUMap<number, string | null>(500);
  // кэш set лайкнутых трек-id (строки) с TTL
  private likesCache: Set<string> | null = null;
  private likesCacheAt = 0;
  // кэш лирики по track_id (null = нет лирики)
  private lyricsCache = new LRUMap<string, string | null>(1000);

  constructor(token: string, refreshCallback: RefreshCallback | null = null) {
    if (!token || typeof token !== "string") throw new Error("токен должен быть непустой строкой");
    this.token = token;
    const s = getSettings();
    this.gate = new AsyncTokenGate(RATE_BURST, s.YANDEX_RATE_LIMIT_INTERVAL * 1000);
    this.maxRetries = s.YANDEX_MAX_RETRIES;
    this.refreshCb = refreshCallback;
  }

  /** явная инициализация (валидация токена через lib.init → account/status). */
  async init(): Promise<void> {
    await this.getLib();
  }

  /** ленивый библиотечный клиент (init загружает аккаунт + валидирует токен). */
  private async getLib(): Promise<LibClient> {
    if (this.lib === null) {
      const lib = new LibClient({ token: this.token });
      await withTimeout(lib.init(), CLIENT_INIT_TIMEOUT, "lib-init");
      this.lib = lib;
    }
    return this.lib;
  }

  private async getYnison(): Promise<YnisonService> {
    if (this.ynison === null) {
      const lib = await this.getLib();
      this.ynison = new YnisonService(lib, this.token);
    }
    return this.ynison;
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
    // сбрасываем — следующий getLib пересоздаст с новым токеном
    this.lib = null;
    this.ynison = null;
    log.info("токен обновлён реактивно после 401");
    return true;
  }

  /** func() с retry: 401 → refresh+повтор, 429 → экспоненциальный backoff. */
  private async withRetry<T>(func: () => Promise<T>, baseDelayMs = 2000): Promise<T> {
    let lastError: unknown = null;
    let refreshTried = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.gate.acquire();
        return await func();
      } catch (e) {
        // библиотека для 401/403 всегда кидает типизированный UnauthorizedError
        // (request.ts: handleErrorResponse) — доверяем instanceof, а не
        // substring-мэтчу текста ошибки: "401"/"429" может встретиться в
        // сообщении по совпадению (например Invalid track id: "42912345"),
        // и тогда невалидный трек ретраился бы как будто он рейт-лимит/401.
        const isUnauthorized = e instanceof LibUnauthorizedError;

        if (isUnauthorized && !refreshTried) {
          lastError = e;
          if (await this.tryRefreshToken()) {
            refreshTried = true;
            continue; // повтор без счётчика — это смена токена, не наш rate limit
          }
          throw e;
        }

        // 429 у библиотеки не имеет своего класса — падает в generic
        // NetworkError с текстом "... (429)" на конце (see request.ts). Матчим
        // именно этот формат, привязанный к концу строки, а не голую подстроку.
        const isRateLimit = e instanceof LibNetworkError && /\(429\)$/.test(e.message);
        if (isRateLimit && attempt < this.maxRetries) {
          const delay = baseDelayMs * 2 ** attempt + Math.random() * 1000;
          log.warning(
            `rate limit, попытка ${attempt + 1}/${this.maxRetries + 1}, ждём ${(delay / 1000).toFixed(1)}с`,
          );
          await sleep(delay);
          lastError = e;
        } else {
          throw e;
        }
      }
    }
    throw new Error(`превышено число попыток: ${lastError}`);
  }

  /** withRetry + единый catch-лог-фолбэк для чтения через lib. */
  private async withLib<T>(
    label: string,
    fallback: T,
    func: (lib: LibClient) => Promise<T>,
    level: "error" | "warning" = "error",
  ): Promise<T> {
    try {
      return await this.withRetry(async () => func(await this.getLib()));
    } catch (e) {
      log[level](`ошибка ${label}: ${e}`);
      return fallback;
    }
  }

  async getTrackById(trackId: number | string): Promise<YaTrack | null> {
    return this.withLib(`getTrackById(${trackId})`, null, async (lib) => {
      const tracks = await lib.tracks([trackId]);
      return tracks.length > 0 ? (tracks[0] as unknown as YaTrack) : null;
    });
  }

  async searchTracks(query: string, limit?: number): Promise<YaTrack[]> {
    const lim = limit ?? getSettings().MAX_SEARCH_RESULTS;
    return this.withLib(`searchTracks(${JSON.stringify(query)})`, [], async (lib) => {
      const result = await lib.search(query, false, "track");
      const tracks = (result?.tracks?.results ?? []) as unknown as YaTrack[];
      return tracks.slice(0, lim);
    });
  }

  /** полная страница поиска треков (для inline-пагинации): результаты + total/perPage. */
  async searchTracksPage(query: string, page = 0): Promise<{ tracks: YaTrack[]; total: number; perPage: number }> {
    return this.withLib(`searchTracksPage(${JSON.stringify(query)}, ${page})`, { tracks: [], total: 0, perPage: 0 }, async (lib) => {
      const result = await lib.search(query, false, "track", page);
      const t = result?.tracks;
      return {
        tracks: (t?.results ?? []) as unknown as YaTrack[],
        total: t?.total ?? 0,
        perPage: t?.perPage ?? 0,
      };
    });
  }

  /** исправленный/канонический текст запроса через /search/suggest (best.text).
   * Лучший-эффект: null при ошибке/отсутствии подсказки. */
  async suggestCorrection(query: string): Promise<string | null> {
    return this.withLib(`suggestCorrection(${JSON.stringify(query)})`, null, async (lib) => {
      const res = await lib.searchSuggest(query);
      return res?.best?.text?.trim() || null;
    }, "warning");
  }

  /** альбом БЕЗ трек-листа (1 запрос) — добор year/labels/genre. */
  async getAlbumShort(albumId: number | string): Promise<YaAlbum | null> {
    return this.withLib(`getAlbumShort(${albumId})`, null, async (lib) => {
      const result = await lib.albums([albumId]);
      return result.length > 0 ? (result[0] as unknown as YaAlbum) : null;
    });
  }

  /** кураторский hex-цвет wave-агента альбома. кэш вечный, на ошибке → null. */
  async getAlbumWaveColor(albumId: number): Promise<string | null> {
    if (this.waveColorCache.has(albumId)) return this.waveColorCache.get(albumId)!;
    let color: string | null = null;
    try {
      color = await withTimeout(this.fetchAlbumWaveColor(albumId), 5_000, "wave-color");
    } catch (e) {
      log.debug(`wave-color ${albumId}: ${e}`);
    }
    this.waveColorCache.set(albumId, color);
    return color;
  }

  private async fetchAlbumWaveColor(albumId: number): Promise<string | null> {
    const lib = await this.getLib();
    const se = await lib.albumsSimilarEntities(albumId);
    const items = (se?.items ?? []) as Array<{
      type?: string;
      data?: { agent?: { animationUri?: string } };
    }>;
    for (const it of items) {
      if (it.type !== "wave_agent_item") continue;
      const uri = it.data?.agent?.animationUri;
      if (uri) {
        const raw = await lib.request.retrieve(uri);
        return waveColorFromLottie(Buffer.from(raw));
      }
    }
    return null;
  }

  /** множество id лайкнутых треков (строки, без album-части). кэш 30с. */
  async getLikedTrackIds(): Promise<Set<string>> {
    const now = performance.now();
    if (this.likesCache !== null && now - this.likesCacheAt < LIKES_CACHE_TTL_MS) {
      return this.likesCache;
    }
    let ids: Set<string>;
    try {
      const lib = await this.getLib();
      const library = await lib.usersLikesTracks();
      ids = new Set((library?.tracks ?? []).map((t) => bareTrackId(t.id)));
    } catch (e) {
      log.debug(`usersLikesTracks: ${e}`);
      return this.likesCache ?? new Set();
    }
    this.likesCache = ids;
    this.likesCacheAt = now;
    return ids;
  }

  async isTrackLiked(trackId: number | string): Promise<boolean> {
    const ids = await this.getLikedTrackIds();
    return ids.has(bareTrackId(trackId));
  }

  /** ставит/снимает лайк; синхронит локальный likesCache (без лишнего фетча). */
  async setTrackLiked(trackId: number | string, liked: boolean): Promise<boolean> {
    const id = bareTrackId(trackId);
    const lib = await this.getLib();
    const ok = liked ? await lib.usersLikesTracksAdd(id) : await lib.usersLikesTracksRemove(id);
    if (ok && this.likesCache !== null) {
      if (liked) this.likesCache.add(id);
      else this.likesCache.delete(id);
    } else if (ok) {
      // кэша ещё не было — точечно не угадать, сбрасываем для свежего фетча
      this.likesCacheAt = 0;
    }
    return ok;
  }

  /** недавно слушанные треки из личной истории (/music-history), плоско + дедуп.
   * Фолбэк на лендинг (play-contexts), если история пуста/недоступна. */
  async getRecentTracks(limit = 12): Promise<YaTrack[]> {
    let ids = await this.recentIdsFromHistory(limit);
    if (ids.length === 0) {
      ids = await this.recentIdsFromLanding(limit);
    }
    if (ids.length === 0) return [];
    try {
      const lib = await this.getLib();
      return (await lib.tracks(ids)) as unknown as YaTrack[];
    } catch (e) {
      log.warning(`[recent] резолв треков: ${e}`);
      return [];
    }
  }

  /** трек-id из /music-history: вкладки по датам → группы → tracks[].data.itemId. */
  private async recentIdsFromHistory(limit: number): Promise<string[]> {
    let history: Awaited<ReturnType<LibClient["musicHistory"]>>;
    try {
      const lib = await this.getLib();
      history = await lib.musicHistory(0);
    } catch (e) {
      log.warning(`music-history: ${e}`);
      return [];
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    const push = (raw: number | string | null | undefined) => {
      if (raw === undefined || raw === null) return;
      const id = bareTrackId(raw);
      if (id && id !== "null" && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    };
    const tabs = history?.historyTabs ?? [];
    for (const tab of tabs) {
      for (const group of tab.items ?? []) {
        for (const item of group.tracks ?? []) {
          push(item.data?.itemId?.trackId);
          if (ids.length >= limit) break;
        }
        if (ids.length >= limit) break;
      }
      if (ids.length >= limit) break;
    }
    log.info(`[recent] music-history → ${ids.length} треков`);
    return ids;
  }

  /** легаси-источник: лендинг play-contexts (otherTracks[].trackId). */
  private async recentIdsFromLanding(limit: number): Promise<string[]> {
    let landing: Awaited<ReturnType<LibClient["landing"]>>;
    try {
      const lib = await this.getLib();
      landing = await lib.landing("play-contexts");
    } catch (e) {
      log.warning(`landing play-contexts: ${e}`);
      return [];
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    const pushRef = (t: { id?: number | string; track_id?: number | string; trackId?: { id?: number | string } }) => {
      const raw = t.trackId?.id ?? t.id ?? t.track_id;
      if (raw === undefined || raw === null) return;
      const id = bareTrackId(raw);
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    };
    for (const block of landing?.blocks ?? []) {
      const data = block.data as
        | {
            otherTracks?: Array<{ id?: number | string; track_id?: number | string; trackId?: { id?: number | string } }>;
            other_tracks?: Array<{ id?: number | string; track_id?: number | string; trackId?: { id?: number | string } }>;
            play_contexts?: Array<{ tracks?: Array<{ id?: number | string; track_id?: number | string; trackId?: { id?: number | string } }> }>;
            playContexts?: Array<{ tracks?: Array<{ id?: number | string; track_id?: number | string; trackId?: { id?: number | string } }> }>;
          }
        | undefined;
      if (!data) continue;
      // основная форма блока play-contexts: data.otherTracks[].trackId
      for (const t of data.otherTracks ?? data.other_tracks ?? []) {
        pushRef(t);
        if (ids.length >= limit) break;
      }
      // фолбэк-форма: data.play_contexts[].tracks[]
      for (const ctx of data.play_contexts ?? data.playContexts ?? []) {
        for (const t of ctx.tracks ?? []) {
          pushRef(t);
          if (ids.length >= limit) break;
        }
        if (ids.length >= limit) break;
      }
      if (ids.length >= limit) break;
    }
    log.info(`[recent] play-contexts (фолбэк) → ${ids.length} треков`);
    return ids;
  }

  /** полный текст песни. кэш вечный, null = нет текста / API недоступен. */
  async getTrackLyrics(trackId: number | string): Promise<string | null> {
    const key = bareTrackId(trackId);
    if (this.lyricsCache.has(key)) return this.lyricsCache.get(key)!;
    let text: string | null = null;
    let apiOk = false;
    try {
      const lib = await this.getLib();
      const lyrics = await withTimeout(lib.tracksLyrics(key), 5_000, "lyrics");
      apiOk = true;
      if (lyrics) {
        text = await withTimeout(lyrics.fetchLyrics(), 5_000, "lyrics-fetch");
      }
    } catch (e) {
      // NotFoundError = у трека нет текста (валидный ответ) → кэшируем null
      if (e instanceof LibNotFoundError) apiOk = true;
      else log.debug(`getTrackLyrics(${key}): ${e}`);
    }
    if (apiOk) this.lyricsCache.set(key, text);
    return text;
  }

  /** LRC-текст трека (синхронизированная лирика). null = нет LRC / API недоступен.
   *  Не кэшируем: тяжёлая операция, вызывается редко (генерация видео). */
  async getTrackLRC(trackId: number | string): Promise<string | null> {
    const key = bareTrackId(trackId);
    try {
      const lib = await this.getLib();
      const lyrics = await withTimeout(lib.tracksLyrics(key, "LRC"), 5_000, "lrc");
      if (!lyrics) return null;
      const text = await withTimeout(lyrics.fetchLyrics(), 5_000, "lrc-fetch");
      if (!text || !isLrc(text)) return null;
      return text;
    } catch (e) {
      if (e instanceof LibNotFoundError) return null;
      log.debug(`getTrackLRC(${key}): ${e}`);
      return null;
    }
  }

  async searchAlbums(query: string, limit = 3): Promise<YaAlbum[]> {
    return this.withLib(`searchAlbums(${JSON.stringify(query)})`, [], async (lib) => {
      const result = await lib.search(query, false, "album");
      const albums = (result?.albums?.results ?? []) as unknown as YaAlbum[];
      return albums.slice(0, limit).filter((a) => a && a.available);
    });
  }

  /** живой ws тяжёлый — кэш 5с, дедуп параллельных, таймаут чтобы inline window не сгорело. */
  async getCurrentTrack(): Promise<CurrentTrack> {
    const now = performance.now();
    if (this.npCache !== null && now - this.npCacheAt < NP_CACHE_TTL_MS) return this.npCache;
    if (this.npInflight !== null) return this.npInflight;

    const fetch = async (): Promise<CurrentTrack> => {
      const ynison = await this.getYnison();
      return withTimeout(ynison.getCurrentTrack(), NP_FETCH_TIMEOUT_MS, "now-playing");
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

  /** вариант загрузки по качеству (best — макс. битрейт, economy — ≤192). */
  async getBestDownloadInfo(track: YaTrack, quality: AudioQuality = "best"): Promise<DownloadInfo | null> {
    try {
      const lib = await this.getLib();
      const infos = (await lib.tracksDownloadInfo(track.id!)) as unknown as DownloadInfo[];
      const chosen = selectDownloadInfo(infos, quality);
      if (chosen === null) return null;
      log.debug(`DownloadInfo для ${track.id} (${quality}): ${chosen.codec} ${chosen.bitrateInKbps}kbps`);
      // chosen — библиотечная модель (несёт getDirectLink) под структурным типом
      return chosen;
    } catch (e) {
      log.error(`ошибка getBestDownloadInfo(${track.id}): ${e}`);
      return null;
    }
  }

  /** lossless/FLAC через /get-file-info. Возвращает LibLosslessDownloadInfo напрямую
   * (несёт urls/key/codec/bitrate/links()/downloadBytes()). null, если эндпоинт не
   * дал ссылок или трек недоступен. */
  async getLosslessDownload(track: YaTrack): Promise<LibLosslessDownloadInfo | null> {
    try {
      const lib = await this.getLib();
      const info = await lib.tracksLosslessInfo(track.id!, "lossless");
      if (!info || info.links().length === 0) return null;
      log.info(`get-file-info ${track.id}: ${info.codec} ${info.bitrate}kbps enc=${Boolean(info.key)} urls=${info.links().length}`);
      return info;
    } catch (e) {
      log.error(`ошибка getLosslessDownload(${track.id}): ${e}`);
      return null;
    }
  }

  async getDownloadUrl(track: YaTrack, quality: AudioQuality = "best"): Promise<string | null> {
    const info = await this.getBestDownloadInfo(track, quality);
    if (info === null) return null;
    return this.directLinkFromInfo(info);
  }

  /** свежая прямая ссылка из готового DownloadInfo (пере-подписывается каждый вызов). */
  async directLinkFromInfo(info: DownloadInfo): Promise<string | null> {
    try {
      const libInfo = info as unknown as LibDownloadInfo;
      libInfo.directLink = undefined; // сбрасываем кэш — нужна свежая подпись (ссылка живёт ~минуту)
      return await libInfo.getDirectLink();
    } catch (e) {
      log.error(`ошибка buildDirectLink: ${e}`);
      return null;
    }
  }

  /** альбом со всеми треками. проставляет _trackNumber / _discNumber. */
  async getAlbum(albumId: number): Promise<AlbumData | null> {
    const album = await this.withLib(`getAlbum(${albumId})`, null, async (lib) => {
      return (await lib.albumsWithTracks(albumId)) as unknown as YaAlbum | null;
    });
    if (!album) return null;

    const tracks: YaTrack[] = [];
    const volumes: YaTrack[][] = [];
    let discIdx = 0;
    for (const volume of album.volumes ?? []) {
      discIdx++;
      const disc: YaTrack[] = [];
      let trackIdx = 0;
      for (const track of volume) {
        trackIdx++;
        if (track && track.available) {
          track._trackNumber = trackIdx;
          track._discNumber = discIdx;
          disc.push(track);
          tracks.push(track);
        }
      }
      volumes.push(disc);
    }

    if (tracks.length === 0) {
      log.warning(`альбом ${albumId} без доступных треков`);
      return null;
    }

    const artist = formatArtists(album.artists);
    const year = album.year ? String(album.year) : "";
    const label = (album.labels && album.labels.length > 0
      ? typeof album.labels[0] === "string"
        ? album.labels[0]
        : (album.labels[0]!.name ?? "")
      : "") || "";
    const genre = album.genre || "";
    const coverUrl = normalizeCoverUrl(album.coverUri || "", "orig");

    log.info(
      `альбом ${albumId}: «${album.title}» ${artist} [${year}], ${tracks.length} треков, ${volumes.length} дисков`,
    );

    return {
      id: albumId,
      title: album.title || "",
      artist,
      year,
      label,
      cover_url: coverUrl,
      genre,
      album_type: album.type || "",
      tracks,
      volumes,
    };
  }

  /** плейлист как AlbumData (переиспользует всю инфру AlbumService: chunked
   *  download/send/retry/resume) — owner из URL, kind = id плейлиста внутри owner. */
  async getPlaylist(owner: string, kind: number): Promise<AlbumData | null> {
    const playlist = await this.withLib(`getPlaylist(${owner}, ${kind})`, null, async (lib) => {
      return (await lib.usersPlaylists(kind, owner)) as unknown as {
        title?: string;
        cover?: { uri?: string };
        tracks?: Array<{ id?: string | number; track?: YaTrack }>;
      } | null;
    });
    if (!playlist) return null;

    const shorts = playlist.tracks ?? [];
    const byId = new Map<string, YaTrack>();
    const idsToFetch: (string | number)[] = [];
    for (const s of shorts) {
      if (s.track) byId.set(String(s.id), s.track);
      else if (s.id !== undefined) idsToFetch.push(s.id);
    }

    if (idsToFetch.length > 0) {
      // POST с телом (не query) — id одним запросом, без постраничного чанкинга.
      // ponytail: для плейлистов в тысячи треков стоит бить на пачки, если
      // вообще станет проблемой — для личной библиотеки это не размер.
      const fetched = await this.withLib(`getPlaylist tracks(${idsToFetch.length})`, [] as YaTrack[], async (lib) => {
        return (await lib.tracks(idsToFetch)) as unknown as YaTrack[];
      });
      for (const t of fetched) if (t?.id !== undefined) byId.set(String(t.id), t);
    }

    const orderedTracks: YaTrack[] = [];
    for (const s of shorts) {
      const t = s.id !== undefined ? byId.get(String(s.id)) : undefined;
      if (t) orderedTracks.push(t);
    }

    return buildPlaylistAlbumData(kind, playlist.title || "", playlist.cover?.uri || "", orderedTracks);
  }

  async close(): Promise<void> {
    this.lib = null;
    this.ynison = null;
  }
}

/** треки плейлиста → AlbumData (переиспользует карточку/выгрузку альбома).
 *  Чистая функция — сеть уже отработала, тут только форма и фильтр available. */
export function buildPlaylistAlbumData(
  kind: number,
  title: string,
  coverUri: string,
  tracks: YaTrack[],
): AlbumData | null {
  const available = tracks.filter((t) => t && t.available);
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

export class YandexClientFactory {
  static async create(
    token: string,
    refreshCallback: RefreshCallback | null = null,
  ): Promise<YandexClient> {
    const service = new YandexClient(token, refreshCallback);
    await service.init(); // сразу валидируем токен (lib.init → account/status)
    return service;
  }
}
