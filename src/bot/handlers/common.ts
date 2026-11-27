import { type DialogManager, StartMode } from "@gramio/dialogs";
import type { Bot } from "gramio";
import { format, MediaUpload } from "gramio";
import { getLogger } from "../../infra/logging.ts";
import { normalizeCoverUrl } from "../../yandex/media.ts";
import { buildCardMeta, formatTrackBasics } from "../../yandex/metadata.ts";
import type { CurrentTrack } from "../../yandex/ynison.ts";
import { senderHandleOf } from "../captions.ts";
import { buildCardImage } from "../cardBuilder.ts";
import type { Container } from "../container.ts";
import { startLogin } from "../dialogs.ts";
import { nowPlayingMarkup } from "../markup.ts";
import { errText } from "../richMessage.ts";
import { say } from "../safeApi.ts";
import {
  ALREADY_SENDING,
  ERROR_RETRY,
  FINDING_PLAYING,
  FINDING_TRACK,
  groupHint,
  LOGIN_FIRST,
  NOTHING_PLAYING,
  privateHint,
  tooOften,
} from "../texts.ts";
import type { TgUser } from "../types.ts";
import { startAlbumUpload } from "./albums.ts";
import { type CardPosition, sendTrackToChat } from "./inline/chat.ts";
import { startPlaylistUpload } from "./playlists.ts";

/** ResetStack: дефолтный Normal пушил бы новый диалог на стек на каждый /start|/help|/settings,
 *  и кнопки прежних меню «протухали бы». */
async function startMenu(ctx: unknown, state: string): Promise<void> {
  await (ctx as { dialog: DialogManager }).dialog.start("menu", state, { startMode: StartMode.ResetStack });
}

const log = getLogger("bot.common");

const START_ALBUM_RE = /^album_(\d+)$/;
const START_TRACK_RE = /^track_(\d+)$/;
// owner сам может содержать '_', поэтому kind — хвостовой _\d+ (жадный owner
// отдаёт ровно последнюю группу цифр). Точка в owner в payload не пролезает —
// телеграм разрешает только [A-Za-z0-9_-] (см. createPlaylistResult).
export const START_PLAYLIST_RE = /^playlist_([\w-]+)_(\d+)$/;

/** общий гейт для карточки и аудио: statusMsgId отличается у каждого вызывающего. */
async function checkLimitAndToken(
  bot: Bot,
  chatId: number,
  user: TgUser,
  container: Container,
  statusMsgId: number | null,
): Promise<string | null> {
  const [allowed, retryAfter] = container.downloadLimiter.check(user.id);
  if (!allowed) {
    await say(bot, chatId, statusMsgId, format`${tooOften(retryAfter)}`);
    return null;
  }
  const token = await container.resolveToken(user.id);
  if (!token) {
    await say(bot, chatId, statusMsgId, format`${LOGIN_FIRST}`);
    return null;
  }
  return token;
}

/** у владельца снимок уже живёт в памяти watcher'а — ходить за ним в Ynison
 * (редирект + ожидание первого фрейма, секунды) незачем. Остальным — как раньше. */
async function currentTrackOf(
  container: Container,
  user: TgUser,
  token: string,
): Promise<Pick<CurrentTrack, "track" | "paused" | "duration_ms" | "progress_ms"> | null> {
  const watcher = container.npWatcher;
  if (watcher !== null && watcher.ownerId === user.id) return watcher.getCurrentSnapshot();
  const yandex = await container.getYandexService(token, user.id);
  return yandex.getCurrentTrack();
}

/** защита от двойного тапа: у юзера одновременно идёт одна отправка трека/карточки. */
const busyUsers = new Set<number>();

async function withUserLock(
  bot: Bot,
  chatId: number,
  userId: number,
  statusMsgId: number | null,
  fn: () => Promise<void>,
): Promise<void> {
  if (busyUsers.has(userId)) {
    await say(bot, chatId, statusMsgId, format`${ALREADY_SENDING}`);
    return;
  }
  busyUsers.add(userId);
  try {
    await fn();
  } finally {
    busyUsers.delete(userId);
  }
}

/** лимит — общий с /np. */
export function renderNowPlaying(
  bot: Bot,
  chatId: number,
  user: TgUser,
  container: Container,
  statusMsgId: number | null,
): Promise<void> {
  return withUserLock(bot, chatId, user.id, statusMsgId, () =>
    renderNowPlayingLocked(bot, chatId, user, container, statusMsgId),
  );
}

async function renderNowPlayingLocked(
  bot: Bot,
  chatId: number,
  user: TgUser,
  container: Container,
  statusMsgId: number | null,
): Promise<void> {
  const token = await checkLimitAndToken(bot, chatId, user, container, statusMsgId);
  if (!token) return;

  try {
    const current = await currentTrackOf(container, user, token);
    const track = current?.track;
    if (!track) {
      await say(bot, chatId, statusMsgId, format`${NOTHING_PLAYING}`);
      return;
    }

    const [artist, title] = formatTrackBasics(track, "");
    const senderHandle = senderHandleOf(user);
    const settings = await container.getUserSettings(user.id);

    // нечисловой id (подкасты/аудиокниги) rich не умеет — обычная карточка
    if (settings.rich_messages && /^\d+$/.test(String(track.id))) {
      // карточка+трек одним сообщением; лимит и токен уже проверены выше, позиция заморожена сейчас
      await sendTrackToChat({
        bot,
        chatId,
        userId: user.id,
        user,
        container,
        trackId: String(track.id),
        trackObj: track,
        token,
        statusMsgId,
        checkLimit: false,
        card: {
          progressMs: current?.progress_ms ?? 0,
          durationMs: current?.duration_ms ?? 0,
          paused: Boolean(current?.paused),
        },
      });
      return;
    }

    const image = await buildCardImage({
      bot,
      container,
      userId: user.id,
      token,
      coverUrl: normalizeCoverUrl(track.coverUri ?? "", "1000x1000"),
      title,
      artist,
      progressMs: current?.progress_ms ?? 0,
      durationMs: current?.duration_ms ?? 0,
      paused: Boolean(current?.paused),
      senderHandle,
      meta: buildCardMeta(track),
      settings,
    });

    await bot.api.sendPhoto({
      chat_id: chatId,
      photo: MediaUpload.buffer(image, "now_playing.jpg"),
      reply_markup: nowPlayingMarkup(track.id!, container.botUsername),
    });
    if (statusMsgId !== null) {
      try {
        await bot.api.deleteMessage({ chat_id: chatId, message_id: statusMsgId });
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    log.error(`[np] ошибка user=${user.id}: ${errText(e)}`);
    await say(bot, chatId, statusMsgId, format`${ERROR_RETRY}`);
  }
}

/** лимит общий с /np. */
export function sendCurrentTrack(
  bot: Bot,
  chatId: number,
  user: TgUser,
  container: Container,
  statusMsgId: number | null,
): Promise<void> {
  return withUserLock(bot, chatId, user.id, statusMsgId, () =>
    sendCurrentTrackLocked(bot, chatId, user, container, statusMsgId),
  );
}

async function sendCurrentTrackLocked(
  bot: Bot,
  chatId: number,
  user: TgUser,
  container: Container,
  statusMsgId: number | null,
): Promise<void> {
  const token = await checkLimitAndToken(bot, chatId, user, container, statusMsgId);
  if (!token) return;

  let current: Awaited<ReturnType<typeof currentTrackOf>>;
  try {
    current = await currentTrackOf(container, user, token);
  } catch (e) {
    log.error(`[current] ошибка user=${user.id}: ${errText(e)}`);
    await say(bot, chatId, statusMsgId, format`${ERROR_RETRY}`);
    return;
  }

  const track = current?.track;
  if (!track) {
    await say(bot, chatId, statusMsgId, format`${NOTHING_PLAYING}`);
    return;
  }

  await sendTrackToChat({
    bot,
    chatId,
    userId: user.id,
    user,
    card: {
      progressMs: current?.progress_ms ?? 0,
      durationMs: current?.duration_ms ?? 0,
      paused: Boolean(current?.paused),
    },
    container,
    trackId: String(track.id),
    trackObj: track,
    token,
    statusMsgId,
    checkLimit: false,
  });
}

function ctxUser(ctx: { from?: TgUser | null }): TgUser {
  if (!ctx.from) throw new Error("ctx.from отсутствует");
  return ctx.from;
}

const isGroupChat = (type: string | undefined): boolean => type === "group" || type === "supergroup";

export function registerCommon(bot: Bot, container: Container): void {
  bot.command("start", async (ctx) => {
    if (isGroupChat(ctx.chat?.type)) {
      await ctx.reply(groupHint(container.botUsername));
      return;
    }
    if (ctx.chat?.type !== "private") return;
    const user = ctxUser(ctx);
    const args = (ctx.args ?? "").trim();
    if (args) {
      const ma = START_ALBUM_RE.exec(args);
      if (ma) {
        await startAlbumUpload(bot, ctx.chat.id, user.id, Number(ma[1]), container);
        return;
      }
      const mt = START_TRACK_RE.exec(args);
      if (mt) {
        await startTrackUploadReply(bot, ctx.chat.id, user, mt[1]!, container);
        return;
      }
      const mp = START_PLAYLIST_RE.exec(args);
      if (mp) {
        await startPlaylistUpload(bot, ctx.chat.id, user.id, mp[1]!, Number(mp[2]), container);
        return;
      }
      if (args === "login") {
        await startMenu(ctx, "main");
        if (!(await container.usersDb.getToken(user.id))) {
          await startLogin((ctx as unknown as { dialog: DialogManager }).dialog, bot, container, user.id);
        }
        return;
      }
    }
    await startMenu(ctx, "main");
  });

  bot.command("help", async (ctx) => {
    if (isGroupChat(ctx.chat?.type)) {
      await ctx.reply(groupHint(container.botUsername));
      return;
    }
    if (ctx.chat?.type !== "private") return;
    await startMenu(ctx, "help");
  });

  bot.command("settings", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    await startMenu(ctx, "settings");
  });

  bot.command("np", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    const status = await ctx.reply(format`${FINDING_PLAYING}`);
    await renderNowPlaying(bot, ctx.chat.id, ctxUser(ctx), container, status.id);
  });
}

/** замыкающий обработчик: личка, обычный текст (не команда) — подсказка вместо тишины.
 *  Регистрировать ПОСЛЕ всех hears/command, иначе перехватит ссылки и команды. */
export function registerPrivateFallback(bot: Bot, container: Pick<Container, "botUsername"> | null = null): void {
  bot.on("message", async (ctx, next) => {
    const text = ctx.text;
    if (ctx.chat?.type !== "private" || !text || text.startsWith("/") || ctx.viaBot) return next();
    await ctx.reply(privateHint(container?.botUsername ?? null));
  });
}

/** зовут и из /start track_<id>, и из ссылки на трек в личке. */
export function startTrackUploadReply(
  bot: Bot,
  chatId: number,
  user: TgUser,
  trackId: string,
  container: Container,
): Promise<void> {
  return withUserLock(bot, chatId, user.id, null, async () => {
    const status = await bot.api.sendMessage({ chat_id: chatId, text: format`${FINDING_TRACK}` });
    await sendTrackToChat({
      bot,
      chatId,
      userId: user.id,
      user,
      card: deepLinkCardPosition(container, user.id, trackId),
      container,
      trackId,
      statusMsgId: status.message_id ?? null,
    });
  });
}

export function deepLinkCardPosition(container: Container, userId: number, trackId: string): CardPosition {
  const watcher = container.npWatcher;
  if (watcher !== null && watcher.ownerId === userId) {
    const snap = watcher.getCurrentSnapshot();
    if (snap?.track && String(snap.track.id) === trackId) {
      return { progressMs: snap.progress_ms ?? 0, durationMs: snap.duration_ms ?? 0, paused: Boolean(snap.paused) };
    }
  }
  return { progressMs: 0, durationMs: 0, paused: false };
}
