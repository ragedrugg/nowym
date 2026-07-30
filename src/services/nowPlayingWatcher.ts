/** Постоянный «сейчас играет» владельца → синхронный снимок для /now-playing и
 * inline fast-path.
 *
 * Тонкий адаптер над RealtimeClient из @dvxch/yandex-music: реконнект, backoff,
 * go-away, стабильный deviceId, stale-детект и pull-снимок живут в либе. Здесь —
 * только специфика бота: токен владельца из БД (на смену токена пересоздаём
 * клиент) и резолв playable_id → Track. */
import { EventEmitter } from "node:events";
import { getLogger } from "../infra/logging.ts";
import { LRUMap } from "../infra/lruMap.ts";
import { withTimeout, createInterruptibleSleep } from "../infra/async.ts";
import type { YaTrack } from "../yandex/types.ts";
import { formatArtists } from "../yandex/metadata.ts";
import { normalizeCoverUrl } from "../yandex/media.ts";
import { trackUrl } from "../yandex/urls.ts";
import {
  Client as LibClient,
  RealtimeClient,
  ANDROID_DEVICE_INFO,
  generateDeviceId,
  type Track as LibTrack,
  type DeviceInfoOverride,
} from "@dvxch/yandex-music";
import type { CurrentTrack } from "../yandex/ynison.ts";
import type { UsersDb } from "../storage/users.ts";

const log = getLogger("services.now_playing");

// Android-идентитет наблюдателя (сервер раскрывает больше полей известному app_name).
const WATCHER_DEVICE_INFO: DeviceInfoOverride = { ...ANDROID_DEVICE_INFO, title: "Мойва" };

const NO_TOKEN_RETRY_MS = 60_000;
const TOKEN_POLL_MS = 30_000;
const TRACKS_LOOKUP_TIMEOUT_MS = 15_000;
const TRACK_CACHE_LIMIT = 200;
// ws жива, но фреймы молчат дольше порога → форс-реконнект (broken pipe без RST).
const STALE_WS_MS = 120_000;
const RECENT_HISTORY_MAX = 20;

/** JSON-safe снимок трека для /now-playing (текущий и история). */
interface NowPlayingTrack {
  id: number | string | null;
  artist: string;
  title: string;
  album: string | null;
  year: number | string | null;
  genre: string | null;
  explicit: boolean;
  url: string;
  cover: string;
}

/** эмитит "change" при каждой смене this.current (для SSE /now-playing/stream). */
export class NowPlayingWatcher extends EventEmitter {
  // публичный — inline fast-path сверяет watcher.ownerId === user.id.
  readonly ownerId: number;
  // JSON-safe snapshot для /now-playing.
  current: NowPlayingTrack | null = null;
  // последние сыгранные треки (новый в начале), из живых trackChange-событий —
  // без похода за Yandex-историей, ограничено памятью процесса.
  private recentHistory: NowPlayingTrack[] = [];

  private readonly usersDb: UsersDb;
  private running = false;
  private stopRequested = false;
  private runPromise: Promise<void> | null = null;
  private readonly sleeper = createInterruptibleSleep();

  private rt: RealtimeClient | null = null;
  private lib: LibClient | null = null;
  private libToken: string | null = null;
  // true с первого state-фрейма сессии (событие open), false на реконнект/stale.
  private connected = false;
  // lookup-кэш lib-Track по playable_id.
  private trackCache = new LRUMap<string, LibTrack>(TRACK_CACHE_LIMIT);
  // СТАБИЛЬНЫЙ id на весь процесс: переживает и реконнекты (внутри RealtimeClient),
  // и пересоздание клиента при смене токена — иначе Ynison дедуплицирует наблюдателя.
  private readonly deviceId = generateDeviceId();

  constructor(usersDb: UsersDb, ownerId: number) {
    super();
    this.usersDb = usersDb;
    this.ownerId = ownerId;
  }

  /** для inline-handler: {track, paused, duration_ms, progress_ms}.
   * progress_ms уже live-интерполирован RealtimeClient.nowPlaying. */
  getCurrentSnapshot(): Pick<
    CurrentTrack,
    "track" | "paused" | "duration_ms" | "progress_ms"
  > | null {
    const np = this.rt?.nowPlaying;
    if (!np || np.track === null) return null;
    return {
      track: np.track as unknown as YaTrack,
      paused: np.paused,
      duration_ms: np.durationMs,
      progress_ms: np.progressMs,
    };
  }

  /** компактный статус для /health. */
  health(): { running: boolean; connected: boolean; lastStateAgeMs: number | null; hasTrack: boolean } {
    return {
      running: this.running,
      connected: this.connected,
      lastStateAgeMs: this.rt?.lastStateAgeMs ?? null,
      hasTrack: (this.rt?.nowPlaying?.track ?? null) !== null,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.runPromise = this.run();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.sleeper.wake();
    this.rt?.stop();
    if (this.runPromise) {
      try {
        await this.runPromise;
      } catch {
        /* ignore */
      }
    }
    this.runPromise = null;
    this.running = false;
  }

  /** ленивый lib-клиент под текущий токен; пересоздаём при смене токена. */
  private ensureLib(token: string): LibClient {
    if (this.lib !== null && this.libToken === token) return this.lib;
    this.lib = new LibClient({ token });
    this.libToken = token;
    this.trackCache = new LRUMap<string, LibTrack>(TRACK_CACHE_LIMIT);
    return this.lib;
  }

  private async resolveTrack(playableId: string): Promise<LibTrack | null> {
    const cached = this.trackCache.get(playableId);
    if (cached !== undefined) return cached;
    if (this.lib === null) return null;
    let tracks: LibTrack[];
    try {
      tracks = await withTimeout(this.lib.tracks([playableId]), TRACKS_LOOKUP_TIMEOUT_MS, `tracks(${playableId})`);
    } catch (e) {
      log.warning(`[np] tracks(${playableId}) упал: ${e}`);
      return null;
    }
    if (tracks.length === 0) return null;
    const track = tracks[0]!;
    this.trackCache.set(playableId, track);
    return track;
  }

  /** обновляет JSON-safe current из сменившегося трека; предыдущий трек (если
   * реально другой, не повторный трекчейндж на тот же id) уходит в историю. */
  private updateCurrent(track: LibTrack | null): void {
    if (track === null) {
      this.current = null;
      this.emit("change");
      return;
    }
    const t = track as unknown as YaTrack;
    const album = t.albums && t.albums.length > 0 ? t.albums[0]! : null;
    const next: NowPlayingTrack = {
      id: t.id ?? null,
      artist: formatArtists(t.artists),
      title: t.title ?? "",
      album: album?.title ?? null,
      year: album?.year ?? null,
      genre: album?.genre ?? t.metaData?.genre ?? null,
      explicit: Boolean(t.explicit),
      url: trackUrl(t.id ?? ""),
      cover: t.coverUri ? normalizeCoverUrl(t.coverUri, "orig") : "",
    };
    if (this.current && this.current.id !== next.id) {
      // realtime иногда флапает trackChange туда-обратно между теми же двумя
      // id (заметно на паузе/резюме) — без дедупа тот же id всплывает в
      // истории несколько раз, а дублирующиеся id ломают keyed-рендер на сайте.
      this.recentHistory = this.recentHistory.filter((t) => t.id !== this.current!.id);
      this.recentHistory.unshift(this.current);
      if (this.recentHistory.length > RECENT_HISTORY_MAX) this.recentHistory.length = RECENT_HISTORY_MAX;
    }
    this.current = next;
    this.emit("change");
  }

  /** последние сыгранные треки, новый первым, без текущего. */
  getRecent(limit = 10): NowPlayingTrack[] {
    return this.recentHistory.slice(0, Math.max(0, limit));
  }

  private async readToken(): Promise<string | null> {
    try {
      return await this.usersDb.getToken(this.ownerId);
    } catch (e) {
      log.warning(`[np] getToken упал: ${e}`);
      return null;
    }
  }

  /** ждёт смены токена владельца в БД (logout/login) либо stopRequested.
   * Promise.race в run() не отменяет проигравшего — если rt.start() решит
   * гонку первым, вызывающая сторона обязана дёрнуть cancel(), иначе этот
   * цикл осиротеет и продолжит опрашивать БД раз в TOKEN_POLL_MS вечно, а
   * каждая следующая итерация run() будет плодить ещё один такой же. */
  private watchToken(token: string): { promise: Promise<void>; cancel: () => void } {
    const { sleep: interruptibleSleep, wake } = createInterruptibleSleep();
    let cancelled = false;
    const promise = (async () => {
      while (!this.stopRequested && !cancelled) {
        await interruptibleSleep(TOKEN_POLL_MS);
        if (this.stopRequested || cancelled) return;
        const fresh = await this.readToken();
        if (fresh && fresh !== token) {
          log.info("[np] токен владельца сменился — пересоздаю realtime-клиент");
          return;
        }
      }
    })();
    return { promise, cancel: () => { cancelled = true; wake(); } };
  }

  /** главный цикл: токен → realtime-клиент (он сам реконнектится) → пересоздание
   * при смене токена. Цикл крутится, пока не stop(). */
  private async run(): Promise<void> {
    while (!this.stopRequested) {
      const token = await this.readToken();
      if (!token) {
        log.warning(
          `[np] нет токена для owner_id=${this.ownerId}, retry через ${(NO_TOKEN_RETRY_MS / 1000).toFixed(0)}s`,
        );
        this.current = null;
        await this.sleeper.sleep(NO_TOKEN_RETRY_MS);
        continue;
      }

      this.ensureLib(token);
      const rt = new RealtimeClient({
        token,
        deviceId: this.deviceId,
        deviceInfo: WATCHER_DEVICE_INFO,
        staleTimeoutMs: STALE_WS_MS,
        resolveTrack: (playableId) => this.resolveTrack(playableId),
      });
      rt.on("open", () => {
        this.connected = true;
      });
      rt.on("reconnect", () => {
        this.connected = false;
      });
      rt.on("stale", (idleMs) => {
        this.connected = false;
        log.info(`[np] ws молчит ${(idleMs / 1000).toFixed(0)}s — переподключаюсь`);
      });
      rt.on("trackChange", ({ track }) => this.updateCurrent(track));
      rt.on("error", (e) => log.warning(`[np] realtime: ${e.message}`));
      this.rt = rt;

      log.info("[np] подключение к Ynison");
      const watcher = this.watchToken(token);
      try {
        // rt.start() реконнектится бесконечно; гонка с watchToken рвёт его на смене токена.
        await Promise.race([rt.start(), watcher.promise]);
      } catch (e) {
        log.error(`[np] неожиданная ошибка realtime-цикла: ${e}`);
      } finally {
        // если гонку решил rt.start() — watcher.promise иначе остался бы висеть
        // и опрашивать БД вечно (см. комментарий watchToken); если решил сам
        // watchToken — cancel() на уже завершённом цикле безвреден.
        watcher.cancel();
        rt.stop();
        this.rt = null;
        this.connected = false;
        this.current = null;
        this.emit("change");
      }
    }
  }
}
