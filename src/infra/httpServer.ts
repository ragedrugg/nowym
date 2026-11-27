/** HTTP-поверхность бота: webhook, /now-playing (+SSE), /health, /metrics.
 * Все зависимости передаются аргументами — модуль без побочных эффектов при импорте. */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Update } from "@yaebal/types";
import { sleep } from "./async.ts";
import { getLogger } from "./logging.ts";
import { counterSnapshot } from "./metrics.ts";
import { secretMatches } from "./secret.ts";

const log = getLogger("infra.http_server");

type WatcherHealth = { running: boolean; connected: boolean; lastStateAgeMs: number | null; hasTrack: boolean };

export interface WatcherLike {
  current: object | null;
  getCurrentSnapshot(): { paused: boolean; progress_ms: number; duration_ms: number } | null;
  getRecent(): unknown[];
  health(): WatcherHealth;
  on(event: "change", fn: () => void): unknown;
  off(event: "change", fn: () => void): unknown;
}

export interface PoolLike {
  ping(): Promise<boolean>;
  stats(): { total: number; idle: number; waiting: number };
}

export interface CacheLike {
  size: number;
  stats(): { size: number; hits: number; misses: number };
}

export interface HttpDeps {
  /** long-polling режим: webhook-роут отключён */
  localApi: boolean;
  webhookPath: string;
  webhookSecret: string;
  tgHandler: (req: IncomingMessage, res: ServerResponse) => unknown;
  nowPlayingToken: string;
  /** пусто — /metrics и детали /health открыты (как раньше) */
  metricsToken: string;
  watcher: WatcherLike | null;
  usersPool: PoolLike;
  cachePool: PoolLike;
  caches: Record<"track" | "avatar" | "settings" | "inline_owners", CacheLike>;
  /** SSE: heartbeat и потолок соединений (для тестов) */
  streamHeartbeatMs?: number;
  streamMaxConnections?: number;
}

/** потолок тела webhook-апдейта (как MAX_BODY у yaebal): больше — 413, апдейт не читаем. */
const WEBHOOK_MAX_BODY = 1 << 20;

/** Webhook-хендлер с семантикой GramIO `webhookHandler(bot, "http")`: тело читается,
 * Telegram сразу получает 200 «ok!», а апдейт обрабатывается в фоне (не держит запрос
 * до конца хендлера — chosen_inline_result качает трек минутами). Ошибки обработки
 * ловит bot.onError внутри handleUpdate; сюда долетает только сбой самого запуска.
 * Битый JSON → реджект (createHttpApp отвечает 400). Секрет и путь проверяет createHttpApp. */
export function createWebhookHandler(
  handleUpdate: (update: Update) => Promise<void>,
  maxBodyBytes = WEBHOOK_MAX_BODY,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return (req, res) =>
    new Promise<void>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      req.on("data", (chunk: Buffer) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > maxBodyBytes) {
          tooLarge = true;
          // остаток тела не дочитываем: ответ и сразу закрыть соединение
          res.writeHead(413, { connection: "close" }).end(() => req.destroy());
          resolve();
          return;
        }
        chunks.push(chunk);
      });
      req.on("error", reject);
      req.on("end", () => {
        if (tooLarge) return;
        let update: Update;
        try {
          update = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Update;
        } catch (e) {
          reject(e);
          return;
        }
        res.writeHead(200).end("ok!");
        resolve();
        void handleUpdate(update).catch((e: unknown) => log.error(`[webhook] обработка апдейта упала: ${e}`));
      });
    });
}

export function bearerMatches(header: string | undefined, token: string): boolean {
  return token !== "" && secretMatches(header, `Bearer ${token}`);
}

export function buildNowPlayingPayload(watcher: WatcherLike | null): unknown {
  if (watcher === null || watcher.current === null) {
    return { playing: false, recent: watcher?.getRecent() ?? [] };
  }
  const snap = watcher.getCurrentSnapshot();
  const progress_ms = snap?.progress_ms ?? null;
  const duration_ms = snap?.duration_ms ?? null;
  return {
    ...watcher.current,
    paused: snap?.paused ?? null,
    progress_ms,
    duration_ms,
    remaining_ms: progress_ms !== null && duration_ms !== null ? Math.max(duration_ms - progress_ms, 0) : null,
    recent: watcher.getRecent(),
  };
}

const NOW_PLAYING_STREAM_HEARTBEAT_MS = 10_000;
// у каждого SSE-клиента свой аплинк до этого процесса — без потолка шквал
// соединений грузит тот же процесс, что держит бота.
const NOW_PLAYING_STREAM_MAX_CONNECTIONS = 20;

const NO_WATCHER: WatcherHealth = { running: false, connected: false, lastStateAgeMs: null, hasTrack: false };

export interface HttpApp {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** завершает все открытые SSE-ответы (для shutdown) */
  closeStreams(): void;
}

export function createHttpApp(deps: HttpDeps): HttpApp {
  const heartbeatMs = deps.streamHeartbeatMs ?? NOW_PLAYING_STREAM_HEARTBEAT_MS;
  const maxStreams = deps.streamMaxConnections ?? NOW_PLAYING_STREAM_MAX_CONNECTIONS;
  const streams = new Set<ServerResponse>();

  const checkNowPlayingAuth = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!deps.nowPlayingToken) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "disabled" }));
      return false;
    }
    if (!bearerMatches(req.headers.authorization, deps.nowPlayingToken)) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return false;
    }
    return true;
  };

  /** METRICS_TOKEN не задан — открыто; задан — нужен Bearer. */
  const metricsAuthorized = (req: IncomingMessage): boolean =>
    !deps.metricsToken || bearerMatches(req.headers.authorization, deps.metricsToken);

  const handleNowPlaying = (req: IncomingMessage, res: ServerResponse): void => {
    if (!checkNowPlayingAuth(req, res)) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildNowPlayingPayload(deps.watcher)));
  };

  const handleStream = (req: IncomingMessage, res: ServerResponse): void => {
    if (!checkNowPlayingAuth(req, res)) return;
    if (streams.size >= maxStreams) {
      res.writeHead(429, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "too_many_streams" }));
      return;
    }
    streams.add(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (): void => {
      res.write(`data: ${JSON.stringify(buildNowPlayingPayload(deps.watcher))}\n\n`);
    };
    send();
    deps.watcher?.on("change", send);
    const heartbeat = setInterval(send, heartbeatMs);
    req.on("close", () => {
      clearInterval(heartbeat);
      deps.watcher?.off("change", send);
      streams.delete(res);
    });
  };

  /** /health: 200=ok, 503=БД лежит. Без METRICS_TOKEN — как раньше (полные данные);
   * с токеном и без Bearer — только {status}. Секретов в теле нет. */
  const handleHealth = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // abort гасит таймеры сразу после гонки — /health дёргает монитор раз в минуту вечно
    const ac = new AbortController();
    const [usersOk, cacheOk] = await Promise.all([
      Promise.race([deps.usersPool.ping(), sleep(3000, ac.signal).then(() => false)]),
      Promise.race([deps.cachePool.ping(), sleep(3000, ac.signal).then(() => false)]),
    ]);
    ac.abort();
    const dbOk = usersOk && cacheOk;
    const status = dbOk ? "ok" : "degraded";
    const body = metricsAuthorized(req)
      ? {
          status,
          uptime_s: Math.round(process.uptime()),
          rss_mb: Math.round(process.memoryUsage().rss / 1048576),
          db: {
            users: { up: usersOk, ...deps.usersPool.stats() },
            cache: { up: cacheOk, ...deps.cachePool.stats() },
          },
          watcher: deps.watcher ? deps.watcher.health() : NO_WATCHER,
          caches: {
            track: deps.caches.track.size,
            avatar: deps.caches.avatar.size,
            settings: deps.caches.settings.size,
            inline_owners: deps.caches.inline_owners.size,
          },
        }
      : { status };
    res.writeHead(dbOk ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  /** /metrics — Prometheus text exposition. */
  const handleMetrics = (req: IncomingMessage, res: ServerResponse): void => {
    if (!metricsAuthorized(req)) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const lines: string[] = [];
    const gauge = (name: string, help: string, value: number, labels = ""): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels} ${value}`);
    };
    const counter = (name: string, help: string, value: number, labels = ""): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`, `${name}${labels} ${value}`);
    };

    gauge("nowym_uptime_seconds", "process uptime in seconds", Math.round(process.uptime()));
    gauge("nowym_rss_bytes", "resident memory in bytes", process.memoryUsage().rss);

    for (const [db, stats] of [
      ["users", deps.usersPool.stats()],
      ["cache", deps.cachePool.stats()],
    ] as const) {
      gauge("nowym_db_pool_total", "postgres pool: total connections", stats.total, `{db="${db}"}`);
      gauge("nowym_db_pool_idle", "postgres pool: idle connections", stats.idle, `{db="${db}"}`);
      gauge("nowym_db_pool_waiting", "postgres pool: waiting acquires", stats.waiting, `{db="${db}"}`);
    }

    for (const [name, cache] of Object.entries(deps.caches)) {
      const stats = cache.stats();
      gauge("nowym_cache_size", "in-memory cache entries", stats.size, `{cache="${name}"}`);
      counter("nowym_cache_hits_total", "in-memory cache hits", stats.hits, `{cache="${name}"}`);
      counter("nowym_cache_misses_total", "in-memory cache misses", stats.misses, `{cache="${name}"}`);
    }

    const w = deps.watcher?.health() ?? NO_WATCHER;
    gauge("nowym_watcher_running", "ynison watcher: process running (1/0)", w.running ? 1 : 0);
    gauge("nowym_watcher_connected", "ynison watcher: ws connected (1/0)", w.connected ? 1 : 0);
    if (w.lastStateAgeMs !== null) {
      gauge("nowym_watcher_last_state_age_ms", "ynison watcher: ms since last state frame", w.lastStateAgeMs);
    }

    for (const [name, value] of counterSnapshot()) {
      counter(`nowym_${name}`, name, value);
    }

    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    res.end(`${lines.join("\n")}\n`);
  };

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (!deps.localApi && req.method === "POST" && url.pathname === deps.webhookPath) {
      // пустой WEBHOOK_SECRET → secretMatches=false → 401 на любой POST
      if (!secretMatches(req.headers["x-telegram-bot-api-secret-token"] as string | undefined, deps.webhookSecret)) {
        res.writeHead(401).end();
        return;
      }
      // реджект (битый JSON и т.п.) без catch = unhandledRejection + алерт и
      // висящий запрос; отвечаем 400, если хендлер ещё не ответил сам.
      (async () => deps.tgHandler(req, res))().catch((e) => {
        log.warning(`webhook-хендлер упал: ${e}`);
        if (!res.headersSent) res.writeHead(400).end();
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/now-playing") {
      handleNowPlaying(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/now-playing/stream") {
      handleStream(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      void handleHealth(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/metrics") {
      handleMetrics(req, res);
      return;
    }
    res.writeHead(404).end();
  };

  const closeStreams = (): void => {
    for (const res of [...streams]) res.end();
  };

  return { handler, closeStreams };
}

/** Остановка сервера: SSE-ответы и keep-alive соединения закрываются принудительно,
 * иначе server.close() ждёт клиентов, которые сами не уйдут. */
export function closeServer(server: Pick<Server, "close" | "closeAllConnections">, app: HttpApp): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    app.closeStreams();
    server.closeAllConnections();
  });
}
