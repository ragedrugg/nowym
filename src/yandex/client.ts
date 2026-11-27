/** Высокоуровневый клиент Yandex Music: кэши, retry, rate-limit, refresh.
 * Поверх @dvxch/yandex-music (каталог/лайки/ynison/download). */
import { performance } from "node:perf_hooks";
import {
  Client as LibClient,
  type ClientOptions as LibClientOptions,
  type DownloadInfo as LibDownloadInfo,
  ForbiddenError as LibForbiddenError,
  type LosslessDownloadInfo as LibLosslessDownloadInfo,
  NetworkError as LibNetworkError,
  NotFoundError as LibNotFoundError,
  TooManyRequestsError as LibTooManyRequestsError,
  UnauthorizedError as LibUnauthorizedError,
} from "@dvxch/yandex-music";
import { sleep, withTimeout } from "../infra/async.ts";
import { getLogger } from "../infra/logging.ts";
import { AsyncTokenGate } from "../infra/rateLimit.ts";
import { getSettings } from "../settings.ts";
import { isLosslessInfo } from "./download.ts";
import type { YandexHealthReport } from "./health.ts";
import { type ApiHealthProbeOptions, probeApiHealth } from "./healthProbe.ts";
import { isLrc } from "./lrc.ts";
import { normalizeCoverUrl } from "./media.ts";
import type { AlbumShortProvider, LikeProvider, WaveColorProvider } from "./metadata.ts";
import { type AudioQuality, bareTrackId, formatArtists, selectDownloadInfo, waveColorFromLottie } from "./metadata.ts";
import { getPlaylist, getPlaylistShort, type LibRunners, resolvePlaylistUuid } from "./playlist.ts";
import { type YandexSharedCaches, yandexSharedCaches } from "./sharedCaches.ts";
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

/** Яндекс недоступен (сеть, таймаут, 5xx, 429): отличаем от «не найдено» в inline/лс. */
export class YandexUnavailableError extends Error {
  constructor(label: string, cause: unknown) {
    super(`яндекс недоступен: ${label}`, { cause });
    this.name = "YandexUnavailableError";
  }
}

/** транспорт/таймаут/5xx/429 — «Яндекс не отвечает»; 4xx и прочее — содержательный ответ. */
function isYandexUnavailable(e: unknown): boolean {
  if (e instanceof LibNetworkError) {
    const status = e.status;
    return status === undefined || status === 429 || status >= 500;
  }
  // withRetry исчерпал попытки (после 429)
  return e instanceof Error && e.message.startsWith("превышено число попыток");
}

export { isLosslessInfo, losslessUrlPicker } from "./download.ts";
export type { ApiHealthProbeOptions } from "./healthProbe.ts";
export { buildPlaylistAlbumData } from "./playlist.ts";

/** async () → новый access_token или null. */
export type RefreshCallback = () => Promise<string | null>;

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
  /** клиент health-проб без ретраев, производный от текущего lib (см. healthLibFor). */
  private health: { source: LibClient; lib: LibClient } | null = null;
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
  // кэш set лайкнутых трек-id (строки) с TTL
  private likesCache: Set<string> | null = null;
  private likesCacheAt = 0;
  // лирика / wave-цвета / definitive-негатив — общие на процесс (sharedCaches.ts).
  // Сбои (таймаут/429/5xx/сеть) не кэшируются вовсе.
  private readonly caches: YandexSharedCaches;
  private readonly now: () => number;

  private readonly libOptions: Partial<LibClientOptions>;
  private readonly sleepFn: (ms: number) => Promise<void>;
  /** withLib/withLibStrict для free-функций playlist.ts. */
  private readonly libRunners: LibRunners = {
    withLib: (label, fallback, func) => this.withLib(label, fallback, func),
    withLibStrict: (label, fallback, func) => this.withLibStrict(label, fallback, func),
  };

  constructor(
    token: string,
    refreshCallback: RefreshCallback | null = null,
    libOptions: Partial<LibClientOptions> = {},
    sleepFn: (ms: number) => Promise<void> = sleep,
    now: () => number = Date.now,
    caches: YandexSharedCaches = yandexSharedCaches,
  ) {
    this.now = now;
    this.caches = caches;
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

  /** Health-пробы идут через view lib.withOptions({retries: 0}) — после таймаута проверки не
   * должно оставаться висящих повторов, а общий транспорт не меняется: временный
   * retries = 0 на нём отнимал ретраи у параллельных пользовательских запросов. */
  private healthLibFor(lib: LibClient): LibClient {
    if (this.health?.source !== lib) {
      // view с общим токеном/состоянием/аккаунтом, но retries: 0 (lib 0.4.1 withOptions)
      this.health = { source: lib, lib: lib.withOptions({ retries: 0 }) };
    }
    return this.health.lib;
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
        // ForbiddenError (403) — подкласс UnauthorizedError в 0.4.1, но токен тут
        // ни при чём (регион/права): refresh на нём не делаем.
        const isUnauthorized = e instanceof LibUnauthorizedError && !(e instanceof LibForbiddenError);

        if (isUnauthorized && !refreshTried) {
          lastError = e;
          if (await this.tryRefreshToken()) {
            refreshTried = true;
            // повтор без счётчика — это смена токена, не наш rate limit; без
            // attempt-- при YANDEX_MAX_RETRIES=0 повтора с новым токеном не было бы
            attempt--;
            continue;
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

  /** как withLib, но недоступность Яндекса (сеть/таймаут/5xx/429) бросает YandexUnavailableError
   * вместо фолбэка — для inline/лс, где пользователь должен отличать сбой от «не найдено». */
  private async withLibStrict<T>(label: string, fallback: T, func: (lib: LibClient) => Promise<T>): Promise<T> {
    try {
      return await this.withRetry(async () => func(await this.getLib()));
    } catch (e) {
      if (isYandexUnavailable(e)) {
        log.warning(`яндекс недоступен ${label}: ${e}`);
        throw new YandexUnavailableError(label, e);
      }
      log.error(`ошибка ${label}: ${e}`);
      return fallback;
    }
  }

  /** strict: сбой Яндекса бросает YandexUnavailableError (inline/лс), иначе — null. */
  async getTrackById(trackId: number | string, opts: { strict?: boolean } = {}): Promise<YaTrack | null> {
    const run = opts.strict ? this.withLibStrict.bind(this) : this.withLib.bind(this);
    return run(`getTrackById(${trackId})`, null, async (lib) => {
      const tracks = await lib.tracks([trackId]);
      return tracks.length > 0 ? (tracks[0] as unknown as YaTrack) : null;
    });
  }

  async searchTracks(query: string, limit?: number, opts: { strict?: boolean } = {}): Promise<YaTrack[]> {
    const lim = limit ?? getSettings().MAX_SEARCH_RESULTS;
    const run = opts.strict ? this.withLibStrict.bind(this) : this.withLib.bind(this);
    return run(`searchTracks(${JSON.stringify(query)})`, [] as YaTrack[], async (lib) => {
      const result = await lib.search(query, false, "track");
      const tracks = (result?.tracks?.results ?? []) as unknown as YaTrack[];
      return tracks.slice(0, lim);
    });
  }

  /** полная страница поиска треков (для inline-пагинации): результаты + total/perPage. */
  async searchTracksPage(
    query: string,
    page = 0,
    opts: { strict?: boolean } = {},
  ): Promise<{ tracks: YaTrack[]; total: number; perPage: number }> {
    const run = opts.strict ? this.withLibStrict.bind(this) : this.withLib.bind(this);
    return run(
      `searchTracksPage(${JSON.stringify(query)}, ${page})`,
      { tracks: [] as YaTrack[], total: 0, perPage: 0 },
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
  async getAlbumShort(albumId: number | string, opts: { strict?: boolean } = {}): Promise<YaAlbum | null> {
    const run = opts.strict ? this.withLibStrict.bind(this) : this.withLib.bind(this);
    return run(`getAlbumShort(${albumId})`, null, async (lib) => {
      const result = await lib.albums([albumId]);
      return result.length > 0 ? (result[0] as unknown as YaAlbum) : null;
    });
  }

  private isNeg(key: string): boolean {
    const until = this.caches.negUntil.peek(key);
    return until !== undefined && until > this.now();
  }

  private setNeg(key: string): void {
    this.caches.negUntil.set(key, this.now() + NEGATIVE_TTL_MS);
  }

  /** кураторский hex-цвет wave-агента альбома. цвет кэшируется вечно, «нет агента» —
   *  на NEGATIVE_TTL_MS, на ошибке → null без кэша. */
  async getAlbumWaveColor(albumId: number): Promise<string | null> {
    const hit = this.caches.waveColor.get(albumId);
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
    if (color) this.caches.waveColor.set(albumId, color);
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
        const raw = await lib.request.retrieve(uri, LIB_TIMEOUT_MS);
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
    const hit = this.caches.lyrics.get(key);
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
    if (text) this.caches.lyrics.set(key, text);
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

  /** Полный read-only health-отчёт Яндекс Музыки — см. healthProbe.ts. */
  async probeApiHealth(opts: ApiHealthProbeOptions): Promise<YandexHealthReport> {
    return probeApiHealth(
      { gate: this.gate, getLib: () => this.getLib(), healthLibFor: (lib) => this.healthLibFor(lib) },
      opts,
    );
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
  async getAlbum(albumId: number, opts: { strict?: boolean } = {}): Promise<AlbumData | null> {
    const run = opts.strict ? this.withLibStrict.bind(this) : this.withLib.bind(this);
    const album = await run(`getAlbum(${albumId})`, null, async (lib) => {
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

  /** ссылка «поделиться» (/playlists/<uuid>) → (owner=uid, kind) — см. playlist.ts. */
  async resolvePlaylistUuid(
    uuid: string,
    opts: { strict?: boolean } = {},
  ): Promise<{ owner: string; kind: number } | null> {
    return resolvePlaylistUuid(this.libRunners, uuid, opts);
  }

  /** шапка плейлиста без резолва треков — для inline-результата (одним запросом). */
  async getPlaylistShort(
    owner: string,
    kind: number,
    opts: { strict?: boolean } = {},
  ): Promise<{ title: string; coverUri: string; trackCount: number } | null> {
    return getPlaylistShort(this.libRunners, owner, kind, opts);
  }

  /** плейлист как AlbumData (owner из URL, kind = id плейлиста внутри owner) — см. playlist.ts. */
  async getPlaylist(owner: string, kind: number, opts: { strict?: boolean } = {}): Promise<AlbumData | null> {
    return getPlaylist(this.libRunners, owner, kind, opts);
  }

  async close(): Promise<void> {
    this.lib = null;
    this.ynison = null;
  }
}

export class YandexClientFactory {
  static async create(token: string, refreshCallback: RefreshCallback | null = null): Promise<YandexClient> {
    const service = new YandexClient(token, refreshCallback);
    await service.init(); // сразу валидируем токен (lib.init → account/status)
    return service;
  }
}
