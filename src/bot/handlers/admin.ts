import type { Bot, InlineKeyboard } from "gramio";
import { bold, type FormattableString, format } from "gramio";
import { getLogger } from "../../infra/logging.ts";
import { formatLatency, measureLatency } from "../../infra/ping.ts";
import { ProgressMessage } from "../../services/albums.ts";
import { broadcastProgressText } from "../../services/broadcast.ts";
import { formatYandexHealth, getYandexHealth } from "../../services/yandexHealth.ts";
import { getSettings } from "../../settings.ts";
import { cachePool, usersPool } from "../../storage/pool.ts";
import { errorDetail } from "../../yandex/health.ts";
import type { Container } from "../container.ts";
import { broadcastConfirmMarkup, broadcastSendingMarkup, healthMarkup, yandexHealthMarkup } from "../markup.ts";
import { safeAnswerCb, safeEditApi } from "../safeApi.ts";
import { ADMIN } from "../texts.ts";

const log = getLogger("bot.admin");

const TG_API = "https://api.telegram.org/";
const YM_API = "https://api.music.yandex.net/";

export function isAdmin(userId: number): boolean {
  const adminId = getSettings().ADMIN_USER_ID;
  // fail-closed: без ADMIN_USER_ID админ-команды не работают ни для кого,
  // иначе любой юзер в личке вытянет operational-метрики через /health.
  if (!adminId) {
    log.warning("[admin] ADMIN_USER_ID не задан — админ-команды отключены");
    return false;
  }
  return userId === adminId;
}

async function buildMainHealth(
  bot: Bot,
  container: Container,
): Promise<{ text: FormattableString; markup: InlineKeyboard }> {
  const [users, counts, usersSize, cacheSize, tgMs, ymMs] = await Promise.all([
    container.usersDb.count().catch(() => null),
    container.cacheDb.counts().catch(() => null),
    container.usersDb.dbSizeBytes().catch(() => 0),
    container.cacheDb.dbSizeBytes().catch(() => 0),
    measureLatency(TG_API, container.httpClient),
    measureLatency(YM_API, container.httpClient),
  ]);

  const dbOk = users !== null && counts !== null;
  const [totalTracks, cachedTracks] = counts ?? [0, 0];
  const dbSizeMb = (usersSize + cacheSize) / (1024 * 1024);
  const tc = container.trackCache.stats();
  const ac = container.avatarCache.stats();

  let channelOk = false;
  try {
    const chat = await bot.api.getChat({ chat_id: getSettings().TELEGRAM_CHANNEL_ID });
    channelOk = chat != null;
  } catch (e) {
    log.warning(`[admin] кэш-канал недоступен: ${e}`);
  }

  const flag = (ok: boolean): FormattableString | string => (ok ? "✅" : "❌");
  const tgOk = tgMs !== null && tgMs < 1000;
  const ymOk = ymMs !== null && ymMs < 1000;
  const botUserOk = Boolean(container.botUsername);

  const w = container.npWatcher?.health() ?? null;
  const wAge = w?.lastStateAgeMs ?? null;
  const wOk = Boolean(w?.running && w?.connected);
  const wLine =
    w === null
      ? format`${flag(false)} ynison-watcher: не запущен (OWNER_ID=0)`
      : format`${flag(wOk)} ynison-watcher: ${w.connected ? "подключён" : "нет ws"}, последний кадр ${wAge === null ? "—" : `${Math.round(wAge / 1000)}с назад`}`;

  const up = usersPool.stats();
  const cp = cachePool.stats();

  const text = format`📊 ${bold("статус")}

${bold("сеть")}
${flag(tgOk)} telegram: ${formatLatency(tgMs)}
${flag(ymOk)} музыка: ${formatLatency(ymMs)}

${bold("база")}
${flag(dbOk)} users ${up.total}/${up.idle}id · cache ${cp.total}/${cp.idle}id · ${dbSizeMb.toFixed(2)} МБ
🎵 треков в кэше: ${cachedTracks}/${totalTracks}
👤 пользователей: ${users ?? "—"}
⚙️ активных загрузок: ${container.downloadQueue.active()}
${flag(channelOk)} кэш-канал доступен
${flag(botUserOk)} bot: @${container.botUsername ?? "?"}
${wLine}

${bold("кэши (in-memory)")}
🔎 поиск: ${tc.size} зап., hit-rate ${tc.hit_rate}
🖼 аватарки: ${ac.size} шт., hit-rate ${ac.hit_rate}
👤 владельцы инлайнов: ${container.inlineOwners.size}`;
  return { text, markup: healthMarkup() };
}

export function registerAdmin(bot: Bot, container: Container): void {
  bot.command("health", async (ctx) => {
    if (ctx.chat?.type !== "private" || !isAdmin(ctx.from!.id)) return;
    const status = await ctx.reply(ADMIN.collecting);
    try {
      const { text, markup } = await buildMainHealth(bot, container);
      await bot.api.editMessageText({
        chat_id: ctx.chat.id,
        message_id: status.id,
        text,
        reply_markup: markup,
      } as never);
    } catch (e) {
      // иначе «⏳ собираю статус...» висит навсегда
      log.warning(`[admin] /health упал: ${e}`);
      await safeEditApi(
        bot,
        { chatId: ctx.chat.id, messageId: status.id },
        format`${ADMIN.collectFailed}
${errorDetail(e)}`,
        healthMarkup(),
      );
    }
  });

  bot.callbackQuery("health:ym", async (ctx) => {
    const chat = ctx.message?.chat;
    if (chat?.type !== "private" || !ctx.from || !isAdmin(ctx.from.id)) {
      await safeAnswerCb(ctx, { text: ADMIN.unavailable, show_alert: true });
      return;
    }
    await safeAnswerCb(ctx);
    const messageId = ctx.message!.id;
    try {
      await safeEditApi(
        bot,
        { chatId: chat.id, messageId },
        format`⏳ ${bold(ADMIN.ymTitle)}${ADMIN.ymCollecting}`,
        yandexHealthMarkup(),
      );
      const report = await getYandexHealth(container, true);
      await safeEditApi(bot, { chatId: chat.id, messageId }, formatYandexHealth(report), yandexHealthMarkup());
    } catch (e) {
      log.warning(`[admin] health:ym упал: ${e}`);
      await safeEditApi(
        bot,
        { chatId: chat.id, messageId },
        format`❌ ${bold(ADMIN.ymTitle)}${ADMIN.ymCollectFailed}
${errorDetail(e)}`,
        yandexHealthMarkup(),
      );
    }
  });

  bot.callbackQuery("health:main", async (ctx) => {
    const chat = ctx.message?.chat;
    if (chat?.type !== "private" || !ctx.from || !isAdmin(ctx.from.id)) {
      await safeAnswerCb(ctx, { text: ADMIN.unavailable, show_alert: true });
      return;
    }
    await safeAnswerCb(ctx);
    const { text, markup } = await buildMainHealth(bot, container);
    await safeEditApi(bot, { chatId: chat.id, messageId: ctx.message!.id }, text, markup);
  });

  bot.command("broadcast", async (ctx) => {
    if (ctx.chat?.type !== "private" || !isAdmin(ctx.from!.id)) return;
    container.broadcastService.startCompose(ctx.from!.id);
    await ctx.reply(ADMIN.broadcastCompose);
  });

  // сразу return, если админ не в режиме композиции рассылки — не мешаем остальным хендлерам.
  bot.on("message", async (ctx, next) => {
    if (ctx.chat?.type !== "private" || !ctx.from || !isAdmin(ctx.from.id)) return next();
    if (!container.broadcastService.isAwaitingContent(ctx.from.id)) return next();

    if (ctx.text === "/cancel") {
      container.broadcastService.cancelCompose(ctx.from.id);
      await ctx.reply(ADMIN.broadcastCancelled);
      return;
    }

    const captured = container.broadcastService.captureContent(ctx.from.id, ctx.chat.id, ctx.id);
    if (!captured) return next();

    const recipients = await container.knownChatsDb.count();
    await ctx.reply(ADMIN.broadcastConfirm(recipients), {
      reply_markup: broadcastConfirmMarkup(),
    } as never);
  });

  bot.callbackQuery("broadcast_cancel", async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    container.broadcastService.cancelCompose(ctx.from.id);
    await ctx.answer(ADMIN.cancelled);
  });

  bot.callbackQuery("broadcast_confirm", async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const adminId = ctx.from.id;
    const pending = container.broadcastService.beginSending(adminId);
    if (!pending) {
      await ctx.answer({ text: ADMIN.draftStale, show_alert: true });
      return;
    }
    await ctx.answer(ADMIN.broadcastStarted);

    const chatId = ctx.message ? ctx.message.chat.id : adminId;
    const progress = ctx.message ? new ProgressMessage(bot, chatId, ctx.message.id) : null;
    if (progress)
      await progress.edit(
        broadcastProgressText({ total: 0, sent: 0, failed: 0, blocked: 0 }, 0),
        broadcastSendingMarkup(),
      );

    const startedAt = performance.now();
    const result = await container.broadcastService.run(adminId, pending.fromChatId, pending.messageId, async (r) => {
      if (progress)
        await progress.edit(broadcastProgressText(r, (performance.now() - startedAt) / 1000), broadcastSendingMarkup());
    });

    if (progress) await progress.edit(broadcastProgressText(result, (performance.now() - startedAt) / 1000));
    log.info(
      `[broadcast] admin=${adminId}: ${result.sent}/${result.total} доставлено, ${result.failed} ошибок, ${result.blocked} заблокировали`,
    );
  });

  bot.callbackQuery("broadcast_stop", async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const stopped = container.broadcastService.requestStop(ctx.from.id);
    await ctx.answer(stopped ? ADMIN.stopping : ADMIN.notRunning);
  });
}
