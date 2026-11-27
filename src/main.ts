/** GramIO webhook через node:http(s) + кастомный роут /now-playing. Фоновые
 * задачи: stale-refresher, чистка пустышек, дочитывание упавших альбомов,
 * ws-наблюдатель Ynison владельца. */

import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createDialogs } from "@gramio/dialogs";
import { redisStorage } from "@gramio/storage-redis";
import { AllowedUpdatesFilter, Bot, webhookHandler } from "gramio";
import { registerCommands } from "./bot/commandsMenu.ts";
import { Container } from "./bot/container.ts";
import { buildMenuDialog } from "./bot/dialogs.ts";
import { registerHandlers } from "./bot/handlers/index.ts";
import { resolveIconSet } from "./bot/iconSet.ts";
import { PollingWatchdog } from "./bot/pollingWatchdog.ts";
import { safeAnswerCb } from "./bot/safeApi.ts";
import { STALE_MENU } from "./bot/texts.ts";
import { AdminAlerter } from "./infra/adminAlerter.ts";
import { schedulePeriodic, sleep } from "./infra/async.ts";
import { closeServer, createHttpApp } from "./infra/httpServer.ts";
import { getLogger } from "./infra/logging.ts";
import { incCounter } from "./infra/metrics.ts";
import { NowPlayingWatcher } from "./services/nowPlayingWatcher.ts";
import { StaleRefresher } from "./services/stale.ts";
import { getSettings } from "./settings.ts";
import { cachePool, usersPool } from "./storage/pool.ts";

const log = getLogger("main");

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
  // $ttl: без него storage-redis пишет SET без срока и ключи копятся вечно. SETEX
  // продлевает срок на каждой записи; кнопки меню, не трогавшегося неделю, просто
  // гасят спиннер (стека нет) — меню открывается заново через /start.
  const dialogStorage = { keyPrefix: "nowym:dialogs:", $ttl: 7 * 24 * 3600 };
  const { plugin: dialogsPlugin, background } = createDialogs([buildMenuDialog(bot, container)], {
    storage: redisStorage(s.REDIS_HOST ? { ...dialogStorage, host: s.REDIS_HOST, port: s.REDIS_PORT } : dialogStorage),
    events: {
      // DialogEventCtx = CallbackCtx | MessageCtx: answer только на callback-ветке → каст
      onStale: (ctx) => safeAnswerCb(ctx as never, STALE_MENU),
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

  await withRetry("bot_init", () => bot.init());
  await container.start(bot);

  // ── фоновые задачи ──────────────────────────────────────────────────
  const staleRefresher = new StaleRefresher(
    {
      cacheDb: container.cacheDb,
      usersDb: container.usersDb,
      cacheService: container.cacheService,
      resolveToken: (uid) => container.resolveToken(uid),
      getYandexClient: (token, uid) => container.getYandexService(token, uid),
    },
    s.STALE_REFRESH_LIMIT,
  );
  staleRefresher.start();

  // первый прогон через 5 мин, а не через 24ч: при рестартах чаще раза в сутки
  // голый setInterval не срабатывал бы никогда.
  const stopStubCleaner = schedulePeriodic(
    () => {
      void container.cacheDb
        .deleteOldStubs(7)
        .then((n) => {
          if (n) log.info(`[stub_cleaner] удалено ${n} пустышек`);
        })
        .catch((e) => log.error(`[stub_cleaner] ошибка: ${e}`));
    },
    5 * 60 * 1000,
    24 * 3600 * 1000,
  );

  // альбомы, упавшие в прошлом запуске — дочитываем в фоне
  void container.albumService
    .resumeInflight({
      resolveToken: (uid) => container.resolveToken(uid),
      getYandexClient: (token, uid) => container.getYandexService(token, uid),
    })
    .catch((e) => log.error(`[album_resume] ${e}`));

  let npWatcher: NowPlayingWatcher | null = null;
  if (s.OWNER_ID) {
    npWatcher = new NowPlayingWatcher(container.usersDb, s.OWNER_ID, {
      // токен отклонён Ynison → принудительный refresh (resolveToken обновляет только за 5 мин до expires_at);
      // AuthService.refreshToken сохраняет пару в БД, run() перечитает её
      refreshToken: () => container.forceRefreshToken(s.OWNER_ID),
    });
    // по слушателю "change" на каждое SSE-соединение — иначе с 11-го летит
    // MaxListenersExceededWarning (дефолт EventEmitter — 10)
    npWatcher.setMaxListeners(25);
    container.npWatcher = npWatcher; // для inline fast-path
    npWatcher.start();
  } else {
    log.info("[np] OWNER_ID=0, наблюдатель не запущен");
  }

  // КРИТИЧНО (webhook-режим): без secret_token кто угодно, зная URL, может слать
  // поддельные апдейты с произвольным from.id. Бот стартует, но все webhook-POST
  // отклоняются с 401 (secretMatches с пустым секретом всегда false). В long-polling
  // апдейты тянутся с доверенного local-сервера — спуфинг невозможен.
  if (s.webhookSecretMissing) {
    log.error("[webhook] WEBHOOK_SECRET не задан — все webhook-запросы будут отклонены (401). Задай WEBHOOK_SECRET.");
  }

  await withRetry("register_commands", () => registerCommands(bot));
  let watchdog: PollingWatchdog | null = null;
  if (localApi) {
    if (s.POLLING_STALL_SEC > 0) {
      // защита от зависшего long-polling (local Bot API server уходил в connect-timeout,
      // и цикл getUpdates молча вставал): обрыв запроса, при повторе — выход, pm2 поднимет
      const wd = new PollingWatchdog({
        stallMs: s.POLLING_STALL_SEC * 1000,
        onFatal: (reason) => {
          incCounter("errors_total");
          alerter?.report(`polling завис: ${reason} — рестарт процесса`);
          setTimeout(() => process.exit(1), 1000).unref();
        },
      });
      bot.onApiCall("getUpdates", wd.hook);
      watchdog = wd;
    }
    // long-polling: deleteWebhook снимает облачный вебхук (на случай переезда),
    // allowedUpdates=all — чтобы inline_query/chosen/callback точно доходили
    await bot.start({ deleteWebhook: true, allowedUpdates: AllowedUpdatesFilter.all });
    watchdog?.start();
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

  const httpApp = createHttpApp({
    localApi,
    webhookPath: s.WEBHOOK_PATH,
    webhookSecret: s.WEBHOOK_SECRET,
    tgHandler,
    nowPlayingToken: s.NOW_PLAYING_TOKEN,
    metricsToken: s.METRICS_TOKEN,
    watcher: npWatcher,
    usersPool,
    cachePool,
    caches: {
      track: container.trackCache,
      avatar: container.avatarCache,
      settings: container.userSettingsCache,
      inline_owners: container.inlineOwners,
    },
  });
  const requestHandler = httpApp.handler;

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
    watchdog?.stop();
    if (npWatcher) await npWatcher.stop();
    // трек, уже начатый до stopped-флага, может тянуться до таймаута скачивания
    // (минимум 10 минут) — не ждём его, чтобы не словить pm2 SIGKILL по kill_timeout.
    await Promise.race([staleRefresher.stop(), sleep(5000)]).catch((e) =>
      log.warning(`[stale] stop на shutdown упал: ${e}`),
    );
    stopStubCleaner();
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
    await closeServer(server, httpApp);
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

// NODE_ENV=test (test/setup.ts) — импорт модуля не поднимает бота
if (process.env.NODE_ENV !== "test") {
  main().catch((e) => {
    log.error(`фатальная ошибка: ${e}`);
    process.exit(1);
  });
}
