/** GramIO webhook через node:http(s) + кастомный роут /now-playing. Фоновые
 * задачи: stale-refresher, чистка пустышек, дочитывание упавших альбомов,
 * ws-наблюдатель Ynison владельца. */

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createDialogs } from "@gramio/dialogs";
import { redisStorage } from "@gramio/storage-redis";
import { AllowedUpdatesFilter, Bot, webhookHandler } from "gramio";
import { registerCommands } from "./bot/commandsMenu.ts";
import { Container } from "./bot/container.ts";
import { buildMenuDialog } from "./bot/dialogs.ts";
import { registerHandlers } from "./bot/handlers/index.ts";
import { resolveIconSet } from "./bot/iconSet.ts";
import { safeAnswerCb } from "./bot/safeApi.ts";
import { AdminAlerter } from "./infra/adminAlerter.ts";
import { sleep } from "./infra/async.ts";
import { getLogger } from "./infra/logging.ts";
import { counterSnapshot, incCounter } from "./infra/metrics.ts";
import { NowPlayingWatcher } from "./services/nowPlayingWatcher.ts";
import { StaleRefresher } from "./services/stale.ts";
import { getSettings } from "./settings.ts";
import { cachePool, usersPool } from "./storage/pool.ts";

const log = getLogger("main");

function secretMatches(header: string | undefined, expected: string): boolean {
  if (!expected) return true; // секрет не задан — не проверяем
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function withRetry(label: string, fn: () => Promise<void>): Promise<void> {
  let delay = 2000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await fn();
      return;
    } catch (e) {
      if (attempt === 6) throw e;
      log.warning(`[startup] ${label} попытка ${attempt} упала (${e}), retry через ${delay / 1000}s`);
      await sleep(delay);
      delay = Math.min(delay * 2, 30000);
    }
  }
}

async function main(): Promise<void> {
  const s = getSettings();
  // Плагин @gramio/auto-retry не годится для 429: переотправляет уже потреблённый
  // payload (→ «there is no audio») без .catch — 429-флуд обрабатывает floodRetry в ChannelSender.
  // BOT_API_BASE_URL задан → self-hosted Bot API server + long-polling; пусто → облако + webhook
  const localApi = Boolean(s.BOT_API_BASE_URL);
  const bot = localApi ? new Bot(s.API_TOKEN, { api: { baseURL: s.BOT_API_BASE_URL } }) : new Bot(s.API_TOKEN);
  const container = new Container();
  const webhookUrl = s.WEBHOOK_HOST.replace(/\/+$/, "") + s.WEBHOOK_PATH;

  // Резолвим ДО buildMenuDialog: тот зашивает icon-id кнопок при сборке, а
  // getStickerSet не требует bot.init(). При сбое кнопки остаются на текстовых глифах.
  await resolveIconSet(bot, s.ICON_SET_NAME);

  // extend ДО registerHandlers: derive ctx.dialog должен стоять раньше хендлеров команд.
  // Хранилище стека диалогов (кнопки) — Redis (localhost:6379), keyPrefix изолирует ключи.
  const { plugin: dialogsPlugin, background } = createDialogs([buildMenuDialog(bot, container)], {
    storage: redisStorage(
      s.REDIS_HOST
        ? { host: s.REDIS_HOST, port: s.REDIS_PORT, keyPrefix: "nowym:dialogs:" }
        : { keyPrefix: "nowym:dialogs:" },
    ),
    events: {
      // DialogEventCtx = CallbackCtx | MessageCtx: answer только на callback-ветке → каст
      onStale: (ctx) => safeAnswerCb(ctx as never, "это меню устарело — открой заново через /start"),
    },
  });
  bot.extend(dialogsPlugin);
  container.dialogBackground = background;

  // Реестр «кто писал боту в личку» — источник получателей для /broadcast.
  // knownChatsDb читаем лениво на каждый вызов: на момент апдейта container.start() уже заполнит поле.
  bot.use((ctx, next) => {
    const chatId = (ctx as { chat?: { id?: number; type?: string } }).chat;
    if (chatId?.type === "private" && typeof chatId.id === "number") {
      void container.knownChatsDb?.touch(chatId.id).catch((e: unknown) => log.debug(`[known_chats] touch: ${e}`));
    }
    return next();
  });

  registerHandlers(bot, container);

  // Ловит исключения в хендлерах, чтобы throw не ронял обработку апдейта целиком.
  // + троттленный алерт админу в личку (первый сразу, дальше не чаще 5 мин).
  const alerter = s.ADMIN_USER_ID
    ? new AdminAlerter((text) => bot.api.sendMessage({ chat_id: s.ADMIN_USER_ID, text }).then(() => undefined))
    : null;
  bot.onError(({ kind, error }) => {
    const msg = `${kind}: ${error?.message ?? error}`;
    log.error(`[onError] ${msg}`);
    incCounter("errors_total");
    alerter?.report(msg);
  });

  // bot.onError ловит только хендлеры — шальной rejected-промис в фоне иначе валит
  // процесс без следа. unhandledRejection логируем без exit; uncaughtException
  // оставляет процесс в неопределённом состоянии — алертим и выходим (pm2 поднимет).
  process.on("unhandledRejection", (reason) => {
    const msg = `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : reason}`;
    log.error(msg);
    incCounter("errors_total");
    alerter?.report(msg);
  });
  process.on("uncaughtException", (error) => {
    const msg = `uncaughtException: ${error?.stack ?? error?.message ?? error}`;
    log.error(msg);
    incCounter("errors_total");
    alerter?.report(msg);
    // даём ~1с алерту долететь, затем выходим — pm2 рестартует
    setTimeout(() => process.exit(1), 1000).unref();
  });

  await bot.init();
  await container.start(bot);

  // ── фоновые задачи ──────────────────────────────────────────────────
  const staleRefresher = new StaleRefresher({
    cacheDb: container.cacheDb,
    usersDb: container.usersDb,
    cacheService: container.cacheService,
    resolveToken: (uid) => container.resolveToken(uid),
    getYandexClient: (token, uid) => container.getYandexService(token, uid),
  });
  staleRefresher.start();

  const stubCleaner = setInterval(
    () => {
      void container.cacheDb
        .deleteOldStubs(7)
        .then((n) => {
          if (n) log.info(`[stub_cleaner] удалено ${n} пустышек`);
        })
        .catch((e) => log.error(`[stub_cleaner] ошибка: ${e}`));
    },
    24 * 3600 * 1000,
  );
  stubCleaner.unref?.();

  // альбомы, упавшие в прошлом запуске — дочитываем в фоне
  void container.albumService
    .resumeInflight({
      resolveToken: (uid) => container.resolveToken(uid),
      getYandexClient: (token, uid) => container.getYandexService(token, uid),
    })
    .catch((e) => log.error(`[album_resume] ${e}`));

  let npWatcher: NowPlayingWatcher | null = null;
  if (s.OWNER_ID) {
    npWatcher = new NowPlayingWatcher(container.usersDb, s.OWNER_ID);
    container.npWatcher = npWatcher; // для inline fast-path
    npWatcher.start();
  } else {
    log.info("[np] OWNER_ID=0, наблюдатель не запущен");
  }

  // КРИТИЧНО (webhook-режим): без secret_token кто угодно, зная URL, может слать
  // поддельные апдейты с произвольным from.id (спуфинг, обход admin-гейта). В
  // long-polling апдейты тянутся с доверенного local-сервера — спуфинг невозможен.
  if (!localApi && !s.WEBHOOK_SECRET) {
    log.warning(
      "[webhook] WEBHOOK_SECRET НЕ ЗАДАН — вебхук принимает любые апдейты без " +
        "проверки. Возможен спуфинг from.id. Задай WEBHOOK_SECRET в .env.",
    );
  }

  await withRetry("register_commands", () => registerCommands(bot));
  if (localApi) {
    // long-polling: deleteWebhook снимает облачный вебхук (на случай переезда),
    // allowedUpdates=all — чтобы inline_query/chosen/callback точно доходили
    await bot.start({ deleteWebhook: true, allowedUpdates: AllowedUpdatesFilter.all });
    log.info(`старт ок, long-polling через ${s.BOT_API_BASE_URL}`);
  } else {
    await withRetry("set_webhook", async () => {
      await bot.api.setWebhook({
        url: webhookUrl,
        drop_pending_updates: true,
        ...(s.WEBHOOK_SECRET ? { secret_token: s.WEBHOOK_SECRET } : {}),
      });
      log.info(`старт ок, webhook → ${webhookUrl}`);
    });
  }

  // ── http(s)-сервер: webhook + /now-playing ──────────────────────────
  const tgHandler = webhookHandler(bot, "http");

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (!localApi && req.method === "POST" && url.pathname === s.WEBHOOK_PATH) {
      if (!secretMatches(req.headers["x-telegram-bot-api-secret-token"] as string | undefined, s.WEBHOOK_SECRET)) {
        res.writeHead(401).end();
        return;
      }
      void tgHandler(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/now-playing") {
      handleNowPlaying(req, res, npWatcher, s.NOW_PLAYING_TOKEN);
      return;
    }

    if (req.method === "GET" && url.pathname === "/now-playing/stream") {
      handleNowPlayingStream(req, res, npWatcher, s.NOW_PLAYING_TOKEN);
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      void handleHealth(res, container, npWatcher);
      return;
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      handleMetrics(res, container, npWatcher);
      return;
    }

    res.writeHead(404).end();
  };

  const useTls = Boolean(s.WEBHOOK_SSL_CERT && s.WEBHOOK_SSL_KEY);
  const server = useTls
    ? createHttpsServer(
        { cert: readFileSync(s.WEBHOOK_SSL_CERT), key: readFileSync(s.WEBHOOK_SSL_KEY) },
        requestHandler,
      )
    : createHttpServer(requestHandler);

  await new Promise<void>((resolve) => server.listen(s.WEBAPP_PORT, s.WEBAPP_HOST, resolve));
  log.info(`http слушает ${s.WEBAPP_HOST}:${s.WEBAPP_PORT} (tls=${useTls ? "on" : "off"})`);

  // ── graceful shutdown ───────────────────────────────────────────────
  const shutdown = async (): Promise<void> => {
    log.info("остановка...");
    if (npWatcher) await npWatcher.stop();
    // трек, уже начатый до stopped-флага, может тянуться до таймаута скачивания
    // (минимум 10 минут) — не ждём его, чтобы не словить pm2 SIGKILL по kill_timeout.
    await Promise.race([staleRefresher.stop(), sleep(5000)]).catch((e) =>
      log.warning(`[stale] stop на shutdown упал: ${e}`),
    );
    clearInterval(stubCleaner);
    if (localApi) {
      await Promise.race([bot.stop(), sleep(5000)]).catch((e) => log.warning(`[polling] stop на shutdown упал: ${e}`));
    } else {
      try {
        await Promise.race([bot.api.deleteWebhook(), sleep(5000)]);
      } catch (e) {
        log.warning(`[webhook] delete_webhook на shutdown упал: ${e}`);
      }
    }
    await container.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    log.info("стоп");
  };

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      void shutdown().then(() => process.exit(0));
    });
  }
}

function buildNowPlayingPayload(watcher: NowPlayingWatcher | null): unknown {
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

function checkNowPlayingAuth(req: IncomingMessage, res: ServerResponse, token: string): boolean {
  if (!token) {
    res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "disabled" }));
    return false;
  }
  if (!secretMatches(req.headers.authorization, `Bearer ${token}`)) {
    res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
    return false;
  }
  return true;
}

function handleNowPlaying(
  req: IncomingMessage,
  res: ServerResponse,
  watcher: NowPlayingWatcher | null,
  token: string,
): void {
  if (!checkNowPlayingAuth(req, res, token)) return;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(buildNowPlayingPayload(watcher)));
}

// heartbeat покрывает paused-дрейф (не событийный) и держит соединение живым
// через прокси/CDN, которые рвут простаивающие стримы.
const NOW_PLAYING_STREAM_HEARTBEAT_MS = 10_000;
// у каждого SSE-клиента свой аплинк до этого процесса (через Worker-прокси
// сайта) — без потолка шквал соединений грузит тот же процесс, что держит
// бота. Легитимных одновременных зрителей у личного сайта в разы меньше.
const NOW_PLAYING_STREAM_MAX_CONNECTIONS = 20;
let nowPlayingStreamConnections = 0;

function handleNowPlayingStream(
  req: IncomingMessage,
  res: ServerResponse,
  watcher: NowPlayingWatcher | null,
  token: string,
): void {
  if (!checkNowPlayingAuth(req, res, token)) return;

  if (nowPlayingStreamConnections >= NOW_PLAYING_STREAM_MAX_CONNECTIONS) {
    res.writeHead(429, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "too_many_streams" }));
    return;
  }
  nowPlayingStreamConnections++;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (): void => {
    res.write(`data: ${JSON.stringify(buildNowPlayingPayload(watcher))}\n\n`);
  };
  send();

  watcher?.on("change", send);
  const heartbeat = setInterval(send, NOW_PLAYING_STREAM_HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    watcher?.off("change", send);
    nowPlayingStreamConnections--;
  });
}

/** /health — без авторизации, без чувствительных данных. 200=ok, 503=БД лежит.
 * Удобно вешать на uptime-монитор: alert по любому не-200. */
async function handleHealth(
  res: ServerResponse,
  container: Container,
  watcher: NowPlayingWatcher | null,
): Promise<void> {
  const [usersOk, cacheOk] = await Promise.all([
    Promise.race([usersPool.ping(), sleep(3000).then(() => false)]),
    Promise.race([cachePool.ping(), sleep(3000).then(() => false)]),
  ]);
  const dbOk = usersOk && cacheOk;

  const body = {
    status: dbOk ? "ok" : "degraded",
    uptime_s: Math.round(process.uptime()),
    rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    db: {
      users: { up: usersOk, ...usersPool.stats() },
      cache: { up: cacheOk, ...cachePool.stats() },
    },
    watcher: watcher ? watcher.health() : { running: false, connected: false, lastStateAgeMs: null, hasTrack: false },
    caches: {
      track: container.trackCache.size,
      avatar: container.avatarCache.size,
      settings: container.userSettingsCache.size,
      inline_owners: container.inlineOwners.size,
    },
  };
  res.writeHead(dbOk ? 200 : 503, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** /metrics — Prometheus text exposition. Те же данные, что /health, плюс
 * счётчики (errors_total, rate_limit_rejections_total, ...) из infra/metrics.ts.
 * Без авторизации — как и /health, ничего чувствительного тут нет. */
function handleMetrics(res: ServerResponse, container: Container, watcher: NowPlayingWatcher | null): void {
  const lines: string[] = [];
  const gauge = (name: string, help: string, value: number, labels = ""): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels} ${value}`);
  };
  const counter = (name: string, help: string, value: number, labels = ""): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`, `${name}${labels} ${value}`);
  };

  gauge("nowym_uptime_seconds", "process uptime in seconds", Math.round(process.uptime()));
  gauge("nowym_rss_bytes", "resident memory in bytes", process.memoryUsage().rss);

  const usersStats = usersPool.stats();
  const cacheStats = cachePool.stats();
  for (const [db, stats] of [
    ["users", usersStats],
    ["cache", cacheStats],
  ] as const) {
    gauge("nowym_db_pool_total", "postgres pool: total connections", stats.total, `{db="${db}"}`);
    gauge("nowym_db_pool_idle", "postgres pool: idle connections", stats.idle, `{db="${db}"}`);
    gauge("nowym_db_pool_waiting", "postgres pool: waiting acquires", stats.waiting, `{db="${db}"}`);
  }

  const caches = {
    track: container.trackCache,
    avatar: container.avatarCache,
    settings: container.userSettingsCache,
    inline_owners: container.inlineOwners,
  };
  for (const [name, cache] of Object.entries(caches)) {
    const stats = cache.stats();
    gauge("nowym_cache_size", "in-memory cache entries", stats.size, `{cache="${name}"}`);
    counter("nowym_cache_hits_total", "in-memory cache hits", stats.hits, `{cache="${name}"}`);
    counter("nowym_cache_misses_total", "in-memory cache misses", stats.misses, `{cache="${name}"}`);
  }

  const w = watcher?.health() ?? { running: false, connected: false, lastStateAgeMs: null, hasTrack: false };
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
}

main().catch((e) => {
  log.error(`фатальная ошибка: ${e}`);
  process.exit(1);
});
