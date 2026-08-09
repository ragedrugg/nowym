/** Постоянный «сейчас играет» владельца через polling Spotify Web API.
 *
 * Заменяет прошлый Ynison-вотчер (Yandex давал ws-плеер, Spotify — нет).
 * Опрашивает /me/player/currently-playing раз в SPOTIFY_NP_POLL_MS пока
 * играет; в паузе/тишине интервал плавно растёт (до 30с). Прогресс между
 * запросами интерполируется по времени. */

import { EventEmitter } from "node:events";
import { createInterruptibleSleep } from "../infra/async.ts";
import { HttpClient } from "../infra/http.ts";
import { getLogger } from "../infra/logging.ts";
import { LRUMap } from "../infra/lruMap.ts";
import { normalizeCoverUrl } from "../music/media.ts";
import { formatArtists } from "../music/metadata.ts";
import type { Track } from "../music/types.ts";
import { trackUrl } from "../music/urls.ts";
import type { CurrentTrack } from "../music/watcher.ts";
import { getSettings } from "../settings.ts";
import type { UsersDb } from "../storage/users.ts";

const log = getLogger("services.now_playing");

const NO_TOKEN_RETRY_MS = 60_000;
const IDLE_MIN_MS = 5_000;
const IDLE_MAX_MS = 30_000;
const RECENT_HISTORY_MAX = 20;
const HTTP_TIMEOUT_MS = 5_000;

interface NowPlayingTrack {
  id: string | null;
  artist: string;
  title: string;
  album: string | null;
  year: number | string | null;
  genre: string | null;
  explicit: boolean;
  url: string;
  cover: string;
}

interface SpotifyImage {
  url: string;
  width?: number;
  height?: number;
}
interface RawTrack {
  id: string;
  name: string;
  duration_ms: number;
  explicit: boolean;
  artists: Array<{ id: string; name: string }>;
  album?: { id: string; name: string; release_date?: string; images?: SpotifyImage[] };
  external_ids?: { isrc?: string };
}
interface RawCurrent {
  is_playing?: boolean;
  progress_ms?: number;
  timestamp?: number;
  item?: RawTrack | null;
  context?: { uri?: string; type?: string };
}

function pickCover(images: SpotifyImage[] | undefined): string {
  if (!images || images.length === 0) return "";
  const mid = images.find((i) => (i.width ?? 0) >= 300 && (i.width ?? 0) <= 640);
  return normalizeCoverUrl(mid?.url || images[0]!.url);
}

function mapRaw(item: RawTrack): Track {
  return {
    id: item.id,
    title: item.name,
    durationMs: item.duration_ms,
    explicit: item.explicit,
    artists: item.artists.map((a) => ({ id: a.id, name: a.name })),
    albums: item.album
      ? [
          {
            id: item.album.id,
            title: item.album.name,
            year: item.album.release_date ? item.album.release_date.slice(0, 4) : "",
            coverUri: pickCover(item.album.images),
          },
        ]
      : [],
    coverUri: pickCover(item.album?.images),
    isrc: item.external_ids?.isrc ?? null,
  };
}

export class NowPlayingWatcher extends EventEmitter {
  readonly ownerId: number;
  current: NowPlayingTrack | null = null;
  private recentHistory: NowPlayingTrack[] = [];
  // последний снимок для inline fast-path.
  private lastSnapshot: {
    track: Track;
    paused: boolean;
    duration_ms: number;
    progress_ms: number;
    fetchedAt: number;
  } | null = null;
  private connected = false;
  private running = false;
  private stopRequested = false;
  private runPromise: Promise<void> | null = null;
  private readonly sleeper = createInterruptibleSleep();
  private readonly usersDb: UsersDb;
  private readonly http = new HttpClient();
  private trackCache = new LRUMap<string, Track>(200);
  private lastPollAt = 0;

  constructor(usersDb: UsersDb, ownerId: number) {
    super();
    this.usersDb = usersDb;
    this.ownerId = ownerId;
  }

  getCurrentSnapshot(): Pick<CurrentTrack, "track" | "paused" | "duration_ms" | "progress_ms"> | null {
    if (!this.lastSnapshot) return null;
    const { track, paused, duration_ms, progress_ms, fetchedAt } = this.lastSnapshot;
    const elapsed = paused ? 0 : Date.now() - fetchedAt;
    const live = Math.max(0, Math.min(progress_ms + elapsed, duration_ms || progress_ms + elapsed));
    return { track, paused, duration_ms, progress_ms: live };
  }

  health(): { running: boolean; connected: boolean; lastStateAgeMs: number | null; hasTrack: boolean } {
    return {
      running: this.running,
      connected: this.connected,
      lastStateAgeMs: this.lastPollAt ? Date.now() - this.lastPollAt : null,
      hasTrack: (this.lastSnapshot?.track ?? null) !== null,
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
    if (this.runPromise) {
      try {
        await this.runPromise;
      } catch {
        /* ignore */
      }
    }
    this.runPromise = null;
    this.running = false;
    await this.http.close().catch(() => {});
  }

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

  private updateCurrent(track: Track | null): void {
    if (track === null) {
      if (this.current !== null) {
        this.current = null;
        this.emit("change");
      }
      return;
    }
    const album = track.albums && track.albums.length > 0 ? track.albums[0]! : null;
    const next: NowPlayingTrack = {
      id: track.id ?? null,
      artist: formatArtists(track.artists),
      title: track.title ?? "",
      album: album?.title ?? null,
      year: album?.year ?? null,
      genre: album?.genre ?? null,
      explicit: Boolean(track.explicit),
      url: track.id ? trackUrl(track.id) : "",
      cover: track.coverUri ?? "",
    };
    if (this.current && this.current.id === next.id) {
      // тот же трек — прогресс сменился, но карточка та же. Не эмитим change,
      // т.к. SSE подписчикам достаточно heartbeat'а.
      this.current = next;
      return;
    }
    if (this.current) {
      this.recentHistory = this.recentHistory.filter((t) => t.id !== this.current!.id);
      this.recentHistory.unshift(this.current);
      if (this.recentHistory.length > RECENT_HISTORY_MAX) this.recentHistory.length = RECENT_HISTORY_MAX;
    }
    this.current = next;
    this.emit("change");
  }

  /** Один POLL /me/player/currently-playing. Возвращает интервал до следующего. */
  private async pollOnce(token: string): Promise<number> {
    const s = getSettings();
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let res;
    try {
      res = await this.http.request("https://api.spotify.com/v1/me/player/currently-playing", {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      clearTimeout(t);
      log.warning(`[np] polling: ${e}`);
      this.connected = false;
      return IDLE_MAX_MS;
    }
    clearTimeout(t);

    if (res.status === 401) {
      await res.body.dump();
      this.connected = false;
      log.info("[np] 401 — токен протух, ждём обновления в БД");
      return NO_TOKEN_RETRY_MS;
    }
    if (res.status === 429) {
      const retry = parseInt(String(res.headers["retry-after"] ?? "5"), 10);
      await res.body.dump();
      return Math.max(retry, 1) * 1000;
    }
    if (res.status === 204) {
      // пустое тело — Spotify: «плеер бездействует».
      await res.body.dump();
      this.connected = true;
      this.lastPollAt = Date.now();
      this.updateCurrent(null);
      this.lastSnapshot = null;
      return IDLE_MAX_MS;
    }
    if (res.status !== 200) {
      const text = await res.body.text().catch(() => "");
      log.warning(`[np] HTTP ${res.status}: ${text.slice(0, 200)}`);
      return IDLE_MAX_MS;
    }
    const raw = (await res.body.json()) as RawCurrent | null;
    this.connected = true;
    this.lastPollAt = Date.now();

    if (!raw || !raw.item) {
      this.updateCurrent(null);
      this.lastSnapshot = null;
      return IDLE_MAX_MS;
    }
    const track = this.getCachedOrMap(raw.item);
    this.updateCurrent(track);
    this.lastSnapshot = {
      track,
      paused: !raw.is_playing,
      duration_ms: raw.item.duration_ms,
      progress_ms: raw.progress_ms ?? 0,
      fetchedAt: Date.now(),
    };
    return raw.is_playing ? s.SPOTIFY_NP_POLL_MS : IDLE_MIN_MS;
  }

  private getCachedOrMap(raw: RawTrack): Track {
    const cached = this.trackCache.get(raw.id);
    if (cached) return cached;
    const t = mapRaw(raw);
    this.trackCache.set(raw.id, t);
    return t;
  }

  private async run(): Promise<void> {
    while (!this.stopRequested) {
      const token = await this.readToken();
      if (!token) {
        log.warning(
          `[np] нет токена для owner_id=${this.ownerId}, retry через ${(NO_TOKEN_RETRY_MS / 1000).toFixed(0)}s`,
        );
        this.current = null;
        this.lastSnapshot = null;
        await this.sleeper.sleep(NO_TOKEN_RETRY_MS);
        continue;
      }
      const wait = await this.pollOnce(token);
      if (this.stopRequested) break;
      await this.sleeper.sleep(wait);
    }
  }
}
