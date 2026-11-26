/** Высокоуровневый клиент Yandex Music: кэши, retry, rate-limit, refresh.
 * Поверх @dvxch/yandex-music (каталог/лайки/ynison/download). */
import { performance } from "node:perf_hooks";
import {
  Client as LibClient,
  type ClientOptions as LibClientOptions,
  type DownloadInfo as LibDownloadInfo,
  type LosslessDownloadInfo as LibLosslessDownloadInfo,
  NetworkError as LibNetworkError,
  NotFoundError as LibNotFoundError,
  TooManyRequestsError as LibTooManyRequestsError,
  UnauthorizedError as LibUnauthorizedError,
} from "@dvxch/yandex-music";
import { sleep, withTimeout } from "../infra/async.ts";
import type { HttpClient } from "../infra/http.ts";
import { getLogger } from "../infra/logging.ts";
import { LRUMap } from "../infra/lruMap.ts";
import { AsyncTokenGate } from "../infra/rateLimit.ts";
import { getSettings } from "../settings.ts";
import { AUDIO_MAGIC_BYTES, assertAudioMagic } from "./audioMagic.ts";
import {
  errorDetail,
  overallFromChecks,
  sortHealthChecks,
  type YandexHealthCheck,
  type YandexHealthReport,
  type YandexProbeTrack,
} from "./health.ts";
import { isLrc } from "./lrc.ts";
import { normalizeCoverUrl } from "./media.ts";
import type { AlbumShortProvider, LikeProvider, WaveColorProvider } from "./metadata.ts";
import { type AudioQuality, bareTrackId, formatArtists, selectDownloadInfo, waveColorFromLottie } from "./metadata.ts";
import type { AlbumData, DownloadInfo, YaAlbum, YaTrack } from "./types.ts";
import { type CurrentTrack, YnisonService } from "./ynison.ts";

const log = getLogger("yandex.client");

/** Ретраи/таймаут транспорта библиотеки (GET и batch POST). Итог на вызов:
 * (LIB_RETRIES + 1) запросов × (NOWYM_429_RETRIES + 1) попыток withRetry = 6. */
const LIB_RETRIES = 1;
const LIB_TIMEOUT_MS = 8_000;
/** Сколько раз withRetry повторяет вызов после 429 (после ретраев библиотеки). */
const NOWYM_429_RETRIES = 2;
/** Верхняя граница паузы между 429-повторами. */
const RETRY_DELAY_CAP_MS = 30_000;

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

/** async () → новый access_token или null. */
export type RefreshCallback = () => Promise<string | null>;

export interface ApiHealthProbeOptions {
  /** HTTP-клиент бота — для Range-проверки CDN без скачивания файла. */
  http: HttpClient;
  /** id текущего/последнего трека; если нет — возьмём из поиска/истории. */
  probeTrackId?: string | number | null;
  /** таймаут одной проверки (не всего отчёта). */
  timeoutMs?: number;
}

const HEALTH_DEPENDENT: Array<Pick<YandexHealthCheck, "key" | "label" | "critical">> = [
  { key: "search", label: "поиск", critical: true },
  { key: "catalog", label: "каталог / треки", critical: true },
  { key: "download_lossy", label: "загрузка mp3/aac", critical: true },
  { key: "download_lossless", label: "lossless / get-file-info", critical: true },
  { key: "cdn", label: "CDN", critical: true },
  { key: "lyrics", label: "лирика", critical: false },
  { key: "likes", label: "лайки", critical: false },
  { key: "history", label: "история", critical: false },
];

// Эталонные треки для проверок, которые нельзя делать на случайном текущем
// треке: у него может не быть FLAC или текста. ID из официального каталога,
// где lossless/лирика точно должны существовать.
const LOSSLESS_PROBE_IDS = ["117708948", "51516485", "60292250"];
const LYRICS_PROBE_IDS = ["51516485", "60292250", "330765"];

type AccountAbout = { geoRegionIso?: string; userSessionRegionIso?: string };

async function readAccountAbout(lib: LibClient): Promise<AccountAbout | null> {
  try {
    const raw = await lib.request.get("https://api.music.yandex.net/account/about");
    if (!raw || typeof raw !== "object") return null;
    const data = raw as Record<string, unknown>;
    return {
      geoRegionIso: typeof data.geoRegionIso === "string" ? data.geoRegionIso : undefined,
      userSessionRegionIso: typeof data.userSessionRegionIso === "string" ? data.userSessionRegionIso : undefined,
    };
  } catch {
    // /account/about не критичен для health: регион — только пояснение
    return null;
  }
}

export function isLosslessInfo(info: LibLosslessDownloadInfo): boolean {
  if ((info as { isLossless?: boolean }).isLossless === true) return true;
  return typeof info.codec === "string" && info.codec.startsWith("flac");
}

function firstHistoryTrackId(
  history: {
    historyTabs?: Array<{ items?: Array<{ tracks?: Array<{ data?: { itemId?: { trackId?: string } } }> }> }>;
  } | null,
): string | null {
  for (const tab of history?.historyTabs ?? []) {
    for (const group of tab.items ?? []) {
      for (const item of group.tracks ?? []) {
        const id = item.data?.itemId?.trackId;
        if (id) return id;
      }
    }
  }
  return null;
}

function probeTrackFrom(track: {
  id?: string | number;
  title?: string;
  artists?: Array<{ name?: string }>;
}): YandexProbeTrack | null {
  if (track.id === undefined || track.id === null) return null;
  const artist = (track.artists ?? [])
    .map((a) => a.name)
    .filter((name): name is string => Boolean(name))
    .join(", ");
  return {
    id: bareTrackId(track.id),
    title: track.title || "без названия",
    artist: artist || "неизвестен",
  };
}

const CLIENT_INIT_TIMEOUT = 9_000;
const NP_CACHE_TTL_MS = 5_000;
const NP_FETCH_TIMEOUT_MS = 4_000;
const LIKES_CACHE_TTL_MS = 30_000;
// TTL definitive-негатива (нет лирики / нет wave-агента)
const NEGATIVE_TTL_MS = 15 * 60_000;
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
  private waveColorCache = new LRUMap<number, string>(500);
  // кэш set лайкнутых трек-id (строки) с TTL
  private likesCache: Set<string> | null = null;
  private likesCacheAt = 0;
  // кэш лирики по track_id (null = нет лирики)
  private lyricsCache = new LRUMap<string, string>(1000);
  // definitive-негатив (нет лирики / нет wave-агента): ключ → момент (мс) истечения.
  // Сбои (таймаут/429/5xx/сеть) не кэшируются вовсе.
  private negUntil = new LRUMap<string, number>(2000);
  private readonly now: () => number;

  private readonly libOptions: Partial<LibClientOptions>;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(
    token: string,
    refreshCallback: RefreshCallback | null = null,
    libOptions: Partial<LibClientOptions> = {},
    sleepFn: (ms: number) => Promise<void> = sleep,
    now: () => number = Date.now,
  ) {
    this.now = now;
    if (!token || typeof token !== "string") throw new Error("токен должен быть непустой строкой");
    this.token = token;
    const s = getSettings();
    this.gate = new AsyncTokenGate(RATE_BURST, s.YANDEX_RATE_LIMIT_INTERVAL * 1000);
    this.maxRetries = s.YANDEX_MAX_RETRIES;
    this.refreshCb = refreshCallback;
    this.libOptions = libOptions;
    this.sleepFn = sleepFn;
  }

  /** явная инициализация (валидация токена через lib.init → account/status). */
  async init(): Promise<void> {
    await this.getLib();
  }

  /** ленивый библиотечный клиент (init загружает аккаунт + валидирует токен). */
  private async getLib(): Promise<LibClient> {
    if (this.lib === null) {
      const lib = new LibClient({
        token: this.token,
        retries: LIB_RETRIES,
        timeout: LIB_TIMEOUT_MS,
        ...this.libOptions,
      });
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

        // 0.4.0: 429 -> TooManyRequestsError (status 429, retryAfterMs). Библиотека
        // уже ретраила GET/batch-POST сама; Retry-After > её retryMaxMs она
        // отдаёт сразу, поэтому ждём не меньше, чем просит сервер. 5xx/таймауты
        // (ServerError/TimedOutError) библиотека тоже уже ретраила: не множим.
        const isRateLimit = e instanceof LibTooManyRequestsError;
        // Retry-After выше потолка паузы: ждать нечего, повтор сервер снова откажет
        if (isRateLimit && (e.retryAfterMs ?? 0) > RETRY_DELAY_CAP_MS) throw e;
        if (isRateLimit && attempt < Math.min(this.maxRetries, NOWYM_429_RETRIES)) {
          const delay = Math.min(
            Math.max(e.retryAfterMs ?? 0, baseDelayMs * 2 ** attempt) + Math.random() * 1000,
            RETRY_DELAY_CAP_MS,
          );
          log.warning(
            `rate limit, попытка ${attempt + 1}/${Math.min(this.maxRetries, NOWYM_429_RETRIES) + 1}, ждём ${(delay / 1000).toFixed(1)}с`,
          );
          await this.sleepFn(delay);
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
    return this.withLib(
      `searchTracksPage(${JSON.stringify(query)}, ${page})`,
      { tracks: [], total: 0, perPage: 0 },
      async (lib) => {
        const result = await lib.search(query, false, "track", page);
        const t = result?.tracks;
        return {
          tracks: (t?.results ?? []) as unknown as YaTrack[],
          total: t?.total ?? 0,
          perPage: t?.perPage ?? 0,
        };
      },
    );
  }

  /** исправленный/канонический текст запроса через /search/suggest (best.text).
   * Лучший-эффект: null при ошибке/отсутствии подсказки. */
  async suggestCorrection(query: string): Promise<string | null> {
    return this.withLib(
      `suggestCorrection(${JSON.stringify(query)})`,
      null,
      async (lib) => {
        const res = await lib.searchSuggest(query);
        return res?.best?.text?.trim() || null;
      },
      "warning",
    );
  }

  /** альбом БЕЗ трек-листа (1 запрос) — добор year/labels/genre. */
  async getAlbumShort(albumId: number | string): Promise<YaAlbum | null> {
    return this.withLib(`getAlbumShort(${albumId})`, null, async (lib) => {
      const result = await lib.albums([albumId]);
      return result.length > 0 ? (result[0] as unknown as YaAlbum) : null;
    });
  }

  private isNeg(key: string): boolean {
    const until = this.negUntil.peek(key);
    return until !== undefined && until > this.now();
  }

  private setNeg(key: string): void {
    this.negUntil.set(key, this.now() + NEGATIVE_TTL_MS);
  }

  /** кураторский hex-цвет wave-агента альбома. цвет кэшируется вечно, «нет агента» —
   *  на NEGATIVE_TTL_MS, на ошибке → null без кэша. */
  async getAlbumWaveColor(albumId: number): Promise<string | null> {
    const hit = this.waveColorCache.get(albumId);
    if (hit) return hit;
    const negKey = `wave:${albumId}`;
    if (this.isNeg(negKey)) return null;
    let color: string | null;
    try {
      color = await withTimeout(this.fetchAlbumWaveColor(albumId), 5_000, "wave-color");
    } catch (e) {
      log.debug(`wave-color ${albumId}: ${e}`);
      return null;
    }
    if (color) this.waveColorCache.set(albumId, color);
    else this.setNeg(negKey);
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
  async getLikedTrackIds(strict = false): Promise<Set<string>> {
    const now = performance.now();
    if (this.likesCache !== null && now - this.likesCacheAt < LIKES_CACHE_TTL_MS) {
      return this.likesCache;
    }
    let ids: Set<string>;
    try {
      ids = await this.withRetry(async () => {
        const lib = await this.getLib();
        const library = await lib.usersLikesTracks();
        return new Set((library?.tracks ?? []).map((t) => bareTrackId(t.id)).filter(Boolean));
      });
    } catch (e) {
      log.debug(`usersLikesTracks: ${e}`);
      if (strict) throw e; // лайк-тоггл не должен гадать «не лайкнут» по пустому списку
      return this.likesCache ?? new Set();
    }
    this.likesCache = ids;
    this.likesCacheAt = now;
    return ids;
  }

  async isTrackLiked(trackId: number | string, strict = false): Promise<boolean> {
    const ids = await this.getLikedTrackIds(strict);
    return ids.has(bareTrackId(trackId));
  }

  /** ставит/снимает лайк; синхронит локальный likesCache (без лишнего фетча). */
  async setTrackLiked(trackId: number | string, liked: boolean): Promise<boolean> {
    const id = bareTrackId(trackId);
    if (!id) return false;
    const ok = await this.withRetry(async () => {
      const lib = await this.getLib();
      return liked ? await lib.usersLikesTracksAdd(id) : await lib.usersLikesTracksRemove(id);
    });
    if (ok && this.likesCache !== null) {
      if (liked) this.likesCache.add(id);
      else this.likesCache.delete(id);
    } else if (ok) {
      // кэша ещё не было — точечно не угадать, сбрасываем для свежего фетча
      this.likesCacheAt = 0;
    }
    return ok;
  }

  /** best-effort репорт "трек играет" в саму Яндекс.Музыку — без этого прослушивания
   * через бота не попадают в историю аккаунта и не двигают "Мою волну". Без withRetry
   * и без выброса наружу намеренно: это телеметрия, не критичная операция — неудача
   * просто теряется, платить за неё бэкоффом/повторами незачем. */
  async reportPlayback(track: YaTrack): Promise<void> {
    const albumId = track.albums?.[0]?.id;
    if (albumId === undefined) return; // playAudio требует albumId — без него нечего репортить
    const trackId = bareTrackId(track.id);
    if (!trackId) return;
    try {
      const lib = await this.getLib();
      await lib.playAudio({ trackId, albumId, from: "Мойва" });
    } catch (e) {
      log.debug(`playAudio: ${e}`);
    }
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
      return await this.withRetry(async () => {
        const lib = await this.getLib();
        return (await lib.tracks(ids)) as unknown as YaTrack[];
      });
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
      if (id && !seen.has(id)) {
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
    for (const block of landing?.blocks ?? []) {
      // PlayContextsData мапит только otherTracks[].trackId.id (библиотека 0.4.0)
      const data = block.data as { otherTracks?: Array<{ trackId?: { id?: number | string } }> } | undefined;
      for (const t of data?.otherTracks ?? []) {
        const raw = t.trackId?.id;
        if (raw === undefined || raw === null) continue;
        const id = bareTrackId(raw);
        if (id && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
        if (ids.length >= limit) break;
      }
      if (ids.length >= limit) break;
    }
    log.info(`[recent] play-contexts (фолбэк) → ${ids.length} треков`);
    return ids;
  }

  /** полный текст песни. текст кэш вечный, «нет текста» — на NEGATIVE_TTL_MS,
   *  null без кэша = сбой API. */
  async getTrackLyrics(trackId: number | string): Promise<string | null> {
    const key = bareTrackId(trackId);
    const hit = this.lyricsCache.get(key);
    if (hit) return hit;
    const negKey = `lyrics:${key}`;
    if (this.isNeg(negKey)) return null;
    let text: string | null = null;
    let definitive = false;
    try {
      text = await this.withRetry(async () => {
        const lib = await this.getLib();
        const lyrics = await withTimeout(lib.tracksLyrics(key), 5_000, "lyrics");
        const t = lyrics ? await withTimeout(lyrics.fetchLyrics(), 5_000, "lyrics-fetch") : null;
        definitive = true; // только после успешного fetchLyrics
        return t;
      });
    } catch (e) {
      // NotFoundError = у трека нет текста (валидный ответ)
      if (e instanceof LibNotFoundError) definitive = true;
      else log.debug(`getTrackLyrics(${key}): ${e}`);
    }
    if (!definitive) return text;
    if (text) this.lyricsCache.set(key, text);
    else this.setNeg(negKey);
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

  /** health-проверка Ynison без требования играющего трека. */
  async probeYnison(): Promise<{ latencyMs: number; detail: string }> {
    const ynison = await this.getYnison();
    return await ynison.probe();
  }

  /** Полный read-only health-отчёт Яндекс Музыки.
   *
   * Всё, что может сломаться в проде: OAuth/аккаунт, поиск, каталог,
   * lossy/lossless-загрузка, CDN, лирика, лайки, история. Ynison проверяется
   * отдельно в services/yandexHealth.ts (watcher или активный probe).
   * Никаких мутаций (playAudio/like) — только чтение. */
  async probeApiHealth(opts: ApiHealthProbeOptions): Promise<YandexHealthReport> {
    const startedAt = performance.now();
    const timeoutMs = opts.timeoutMs ?? 6_000;
    const checks: YandexHealthCheck[] = [];
    let probeTrack: YandexProbeTrack | null = null;
    let accountGeo: string | null = null;

    const finish = (): YandexHealthReport => {
      const sorted = sortHealthChecks(checks);
      return {
        checkedAt: Date.now(),
        durationMs: Math.round(performance.now() - startedAt),
        overall: overallFromChecks(sorted),
        probeTrack,
        checks: sorted,
      };
    };

    const addSkip = (key: string, label: string, critical: boolean, detail: string): void => {
      checks.push({ key, label, critical, status: "skip", latencyMs: null, detail });
    };

    const probe = async <T>(
      key: string,
      label: string,
      critical: boolean,
      fn: () => Promise<T>,
      describe: (value: T) => string,
    ): Promise<T | null> => {
      const checkStarted = performance.now();
      let requestStarted = checkStarted;
      try {
        // ждём rate-gate отдельно: его очередь не должна съедать per-check
        // таймаут реального запроса (иначе поздние проверки ложно падают)
        await this.gate.acquire();
        requestStarted = performance.now();
        // без ретраев библиотеки: после таймаута проверки не должно оставаться
        // висящих повторных запросов (число попыток читается при старте вызова)
        const savedRetries = this.lib?.request.retries;
        if (this.lib && savedRetries !== undefined) this.lib.request.retries = 0;
        let value: T;
        try {
          value = await withTimeout(fn(), timeoutMs, key);
        } finally {
          if (this.lib && savedRetries !== undefined) this.lib.request.retries = savedRetries;
        }
        checks.push({
          key,
          label,
          critical,
          status: "ok",
          latencyMs: Math.round(performance.now() - requestStarted),
          detail: describe(value),
        });
        return value;
      } catch (e) {
        checks.push({
          key,
          label,
          critical,
          status: "fail",
          latencyMs: Math.round(performance.now() - requestStarted),
          detail: errorDetail(e),
        });
        return null;
      }
    };

    const authStarted = performance.now();
    let lib: LibClient;
    try {
      lib = await withTimeout(this.getLib(), timeoutMs, "health-auth");
    } catch (e) {
      checks.push({
        key: "auth",
        label: "аккаунт / OAuth",
        critical: true,
        status: "fail",
        latencyMs: Math.round(performance.now() - authStarted),
        detail: errorDetail(e),
      });
      for (const dep of HEALTH_DEPENDENT) addSkip(dep.key, dep.label, dep.critical, "не проверено: нет авторизации");
      return finish();
    }

    try {
      const [me, about] = await withTimeout(
        Promise.all([lib.accountStatus(), readAccountAbout(lib)]),
        timeoutMs,
        "health-account",
      );
      const serviceAvailable = me !== null && me.account?.serviceAvailable !== false;
      let detail = serviceAvailable ? `сервис доступен${me.plus?.hasPlus ? ", Plus активен" : ""}` : "токен не принят";
      if (serviceAvailable && about?.geoRegionIso) {
        const geo = about.geoRegionIso.toUpperCase();
        accountGeo = geo;
        const session = about.userSessionRegionIso?.toUpperCase();
        detail += `; регион ${geo}${session && session !== geo ? `, сессия ${session}` : ""}`;
      }
      checks.push({
        key: "auth",
        label: "аккаунт / OAuth",
        critical: true,
        status: serviceAvailable ? "ok" : "fail",
        latencyMs: Math.round(performance.now() - authStarted),
        detail,
      });
      if (!serviceAvailable) {
        for (const dep of HEALTH_DEPENDENT) addSkip(dep.key, dep.label, dep.critical, "не проверено: токен не принят");
        return finish();
      }
    } catch (e) {
      checks.push({
        key: "auth",
        label: "аккаунт / OAuth",
        critical: true,
        status: "fail",
        latencyMs: Math.round(performance.now() - authStarted),
        detail: errorDetail(e),
      });
      for (const dep of HEALTH_DEPENDENT)
        addSkip(dep.key, dep.label, dep.critical, "не проверено: авторизация не прошла");
      return finish();
    }

    const searchResult = await probe(
      "search",
      "поиск",
      true,
      async () => lib.search("Daft Punk", false, "track"),
      (r) => {
        const n = (r?.tracks?.results ?? []).length;
        return n > 0 ? `поиск отвечает, найдено ${n}` : "поиск отвечает, результатов нет";
      },
    );

    let catalogTrackId: string | null = null;
    if (opts.probeTrackId != null) catalogTrackId = bareTrackId(opts.probeTrackId);
    if (!catalogTrackId) {
      const first = (searchResult?.tracks?.results ?? [])[0] as { id?: string | number } | undefined;
      if (first?.id != null) catalogTrackId = bareTrackId(first.id);
    }
    if (!catalogTrackId) {
      try {
        const history = await lib.musicHistory(0);
        catalogTrackId = firstHistoryTrackId(history as any);
      } catch {
        /* ignore */
      }
    }

    let catalogTrack: any = null;
    if (catalogTrackId) {
      catalogTrack = await probe(
        "catalog",
        "каталог / треки",
        true,
        async () => {
          const tracks = await lib.tracks([catalogTrackId!]);
          if (!tracks || tracks.length === 0) throw new Error("трек не найден");
          return tracks[0];
        },
        (t) => {
          probeTrack = probeTrackFrom(t as any);
          return probeTrack ? `трек доступен: ${probeTrack.artist} — ${probeTrack.title}` : "трек доступен";
        },
      );
    } else {
      addSkip("catalog", "каталог / треки", true, "не удалось выбрать пробный трек");
    }

    // lossy download
    let lossyLink: string | null = null;
    const lossyTrackId = catalogTrackId;
    if (lossyTrackId) {
      const infos = await probe(
        "download_lossy",
        "загрузка mp3/aac",
        true,
        async () => {
          const arr = (await lib.tracksDownloadInfo(lossyTrackId)) as unknown as LibDownloadInfo[];
          if (!arr || arr.length === 0) throw new Error("нет вариантов загрузки");
          return arr;
        },
        (arr) => {
          const best = selectDownloadInfo(arr as any, "best");
          return best ? `вариант: ${best.codec} ${best.bitrateInKbps}kbps` : `вариантов: ${arr.length}`;
        },
      );
      if (infos) {
        const chosen = selectDownloadInfo(infos as any, "best") as unknown as LibDownloadInfo | null;
        if (chosen) {
          try {
            chosen.directLink = undefined;
            lossyLink = await chosen.getDirectLink();
          } catch {
            lossyLink = null;
          }
        }
      }
    } else {
      addSkip("download_lossy", "загрузка mp3/aac", true, "не удалось выбрать пробный трек");
    }

    // lossless: перебираем эталонные id, пока кто-то не отдаст настоящий lossless;
    // lossy-ответ (нет Plus / нет lossless-источника) — degraded, а не ok
    let losslessLink: string | null = null;
    let losslessCodec: string | null = null;
    const info = await probe(
      "download_lossless",
      "lossless / get-file-info",
      true,
      async () => {
        let lossy: LibLosslessDownloadInfo | null = null;
        let lastError: unknown = new Error("нет lossless-инфо");
        for (const id of LOSSLESS_PROBE_IDS) {
          try {
            const i = (await lib.tracksFileInfo(id, { quality: "lossless" }))?.downloadInfo;
            if (!i) continue;
            if (isLosslessInfo(i)) return i;
            lossy ??= i;
          } catch (e) {
            lastError = e;
          }
        }
        if (lossy) return lossy;
        throw lastError;
      },
      (i) => (isLosslessInfo(i) ? `lossless доступен: ${i.codec}` : `ответ получен: ${i.codec}`),
    );
    if (info) {
      losslessLink = info.links()[0] ?? null;
      losslessCodec = info.codec ?? null;
      if (!isLosslessInfo(info)) {
        // критичная проверка не должна быть ok при lossy-ответе: понижаем до некритичной ошибки → overall degraded
        const check = checks.find((c) => c.key === "download_lossless");
        if (check) {
          check.status = "fail";
          check.critical = false;
          check.detail = `lossless недоступен, отдан ${info.codec ?? "?"}`;
        }
        losslessLink = null;
      }
    }

    // CDN probe: для lossless — Range первых байт + проверка контейнера
    const cdnUrl = losslessLink || lossyLink;
    if (cdnUrl) {
      await probe(
        "cdn",
        "CDN",
        true,
        async () => {
          if (losslessLink) {
            const res = await opts.http.request(losslessLink, {
              headers: { Range: `bytes=0-${AUDIO_MAGIC_BYTES - 1}` },
            });
            let head: Buffer = Buffer.alloc(0);
            try {
              if (res.status >= 400) throw new Error(`CDN ответ ${res.status}`);
              for await (const chunk of res.body) {
                head = Buffer.from(chunk as Uint8Array);
                break;
              }
            } finally {
              res.body.destroy();
            }
            assertAudioMagic(head, losslessCodec);
            return res;
          }
          const res = await opts.http.headOrRange(cdnUrl, 0, 0);
          if (!res || res.status >= 400) throw new Error(`CDN ответ ${res?.status ?? "?"}`);
          return res;
        },
        () => (losslessLink ? "lossless CDN отвечает, контейнер корректен" : "CDN отвечает"),
      );
    } else {
      addSkip("cdn", "CDN", true, "нет ссылки для проверки");
    }

    // lyrics
    const lyricsId = LYRICS_PROBE_IDS[0] || catalogTrackId;
    if (lyricsId) {
      await probe(
        "lyrics",
        "лирика",
        false,
        async () => {
          const lyrics = await lib.tracksLyrics(lyricsId, "LRC");
          if (!lyrics) throw new Error("нет лирики");
          const text = await lyrics.fetchLyrics();
          if (!text) throw new Error("пустой текст лирики");
          return text;
        },
        (text) => `лирика доступна, ${String(text).length} символов`,
      );
    } else {
      addSkip("lyrics", "лирика", false, "нет пробного трека");
    }

    // likes
    await probe(
      "likes",
      "лайки",
      false,
      async () => lib.usersLikesTracks(),
      (libRes) => `лайки доступны${(libRes as any)?.tracks ? `, ${(libRes as any).tracks.length} треков` : ""}`,
    );

    // history
    await probe(
      "history",
      "история",
      false,
      async () => lib.musicHistory(0),
      (h) => {
        const tabs = (h as any)?.historyTabs?.length ?? 0;
        return tabs > 0 ? `история доступна, вкладок ${tabs}` : "история доступна";
      },
    );

    return finish();
  }

  /** вариант загрузки по качеству (best — макс. битрейт, economy — ≤192). */
  async getBestDownloadInfo(track: YaTrack, quality: AudioQuality = "best"): Promise<DownloadInfo | null> {
    try {
      return await this.withRetry(async () => {
        const lib = await this.getLib();
        const infos = (await lib.tracksDownloadInfo(track.id!)) as unknown as DownloadInfo[];
        const chosen = selectDownloadInfo(infos, quality);
        if (chosen === null) return null;
        log.debug(`DownloadInfo для ${track.id} (${quality}): ${chosen.codec} ${chosen.bitrateInKbps}kbps`);
        // chosen — библиотечная модель (несёт getDirectLink) под структурным типом
        return chosen;
      });
    } catch (e) {
      log.error(`ошибка getBestDownloadInfo(${track.id}): ${e}`);
      return null;
    }
  }

  /** lossless через /get-file-info, transport raw (без шифрования; flac-mp4 = ftyp-контейнер).
   * Возвращает LibLosslessDownloadInfo (urls/codec/bitrate/links()). null, если эндпоинт не
   * дал ссылок, трек недоступен или отдал lossy (нет Plus / нет lossless-источника) —
   * вызывающие тогда честно уходят в lossy-тир с пометкой degraded. */
  async getLosslessDownload(track: YaTrack): Promise<LibLosslessDownloadInfo | null> {
    const id = bareTrackId(track.id);
    if (!id) return null;
    try {
      return await this.withRetry(async () => {
        const lib = await this.getLib();
        const info = (await lib.tracksFileInfo(id, { quality: "lossless" }))?.downloadInfo;
        if (!info || info.links().length === 0) return null;
        if (info.isEncrypted) {
          // transports=raw проигнорирован: шифртекст иначе скачался бы целиком и отвергся по магии
          log.warning(`[lossless] ${track.id}: сервер отдал encrypted-поток при transports=raw — пропуск`);
          return null;
        }
        log.info(`get-file-info ${track.id}: ${info.codec} urls=${info.links().length}`);
        if (!isLosslessInfo(info)) {
          log.warning(`[lossless] ${track.id}: запрошен lossless, получен ${info.codec} — деградация в lossy`);
          return null;
        }
        return info;
      });
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
      return await this.withRetry(async () => {
        const libInfo = info as unknown as LibDownloadInfo;
        libInfo.directLink = undefined; // сбрасываем кэш — нужна свежая подпись (ссылка живёт ~минуту)
        return await libInfo.getDirectLink();
      });
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
    const label =
      (album.labels && album.labels.length > 0
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

  /** сырой ответ usersPlaylists: треки тут — «короткие» (часто только id). */
  private async fetchPlaylist(owner: string, kind: number) {
    return this.withLib(`getPlaylist(${owner}, ${kind})`, null, async (lib) => {
      return (await lib.usersPlaylists(kind, owner)) as unknown as {
        title?: string;
        cover?: { uri?: string };
        tracks?: Array<{ id?: string | number; track?: YaTrack }>;
      } | null;
    });
  }

  /** шапка плейлиста без резолва треков — для inline-результата (одним запросом). */
  async getPlaylistShort(
    owner: string,
    kind: number,
  ): Promise<{ title: string; coverUri: string; trackCount: number } | null> {
    const playlist = await this.fetchPlaylist(owner, kind);
    if (!playlist) return null;
    return {
      title: playlist.title || "",
      coverUri: playlist.cover?.uri || "",
      trackCount: playlist.tracks?.length ?? 0,
    };
  }

  /** плейлист как AlbumData (переиспользует всю инфру AlbumService: chunked
   *  download/send/retry/resume) — owner из URL, kind = id плейлиста внутри owner. */
  async getPlaylist(owner: string, kind: number): Promise<AlbumData | null> {
    const playlist = await this.fetchPlaylist(owner, kind);
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
  static async create(token: string, refreshCallback: RefreshCallback | null = null): Promise<YandexClient> {
    const service = new YandexClient(token, refreshCallback);
    await service.init(); // сразу валидируем токен (lib.init → account/status)
    return service;
  }
}
