import { type DialogManager, StartMode } from "@gramio/dialogs";
import type { Bot } from "gramio";
import { blockquote, bold, code, type FormattableString, format, MediaUpload } from "gramio";
import { getLogger } from "../../infra/logging.ts";
import { normalizeCoverUrl } from "../../yandex/media.ts";
import { buildCardMeta, formatTrackBasics } from "../../yandex/metadata.ts";
import type { YaTrack } from "../../yandex/types.ts";
import type { CurrentTrack } from "../../yandex/ynison.ts";
import { senderHandleOf } from "../captions.ts";
import { buildCardImage } from "../cardBuilder.ts";
import type { Container } from "../container.ts";
import { startLogin } from "../dialogs.ts";
import { LOGIN_FIRST, nowPlayingMarkup } from "../markup.ts";
import { errText } from "../richMessage.ts";
import { say } from "../safeApi.ts";
import { startAlbumUpload } from "./albums.ts";
import { type CardPosition, sendTrackToChat } from "./inline.ts";
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

export interface TgUser {
  id: number;
  username?: string | null;
  firstName?: string | null;
}

export function startText(loggedIn: boolean): FormattableString {
  const base = format`привет 👋\n\nэто бот для одного жёлтого музыкального сервиса. кидает треки прямо в телеграм — по названию, по ссылке или просто тот, который у тебя сейчас играет\n\n`;
  const tail = loggedIn
    ? "набери @nowymbot название в любом чате — или жми кнопки ниже"
    : "чтобы всё заработало — войди, это минута";
  return format`${base}${tail}`;
}

export function helpText(): FormattableString {
  return format`🎵 ${bold("что я умею")}
кидаю треки, альбомы и плейлисты прямо в телеграм — по названию, ссылке, цитате из песни или тот, что играет у тебя сейчас.

⌨️ ${bold("inline — в любом чате")}
набери ${code("@nowymbot")} и через пробел:
${blockquote(format`${code("название")} — поиск треков и альбомов
${code("ссылка")} — трек, альбом или плейлист по ссылке
${code("(пусто)")} — что играет сейчас + карточка
${code('"строка из песни"')} — поиск по цитате + текст песни
${code("недавнее")} — история прослушиваний (листается)
${code("ncore / speed / slow")} + название — эффект: nightcore / спидап / slowed+reverb`)}

💬 ${bold("в личке")}
${blockquote(format`ссылка на трек, альбом или плейлист — пришлю сюда (альбом и плейлист — выгрузкой)
${code("что играет")} (кнопка в меню) — пришлю сам трек, который играет сейчас
${code("/np")} — карточка того, что играет сейчас
${code("/settings")} — качество, подписи, карточка
${code("/login")} · ${code("/logout")} — вход и выход`)}`;
}

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
    await say(bot, chatId, statusMsgId, format`⏳ слишком часто, подожди ${Math.round(retryAfter)} сек`);
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
    await say(bot, chatId, statusMsgId, format`⏳ уже отправляю...`);
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
      await say(bot, chatId, statusMsgId, format`🎵 сейчас ничего не играет`);
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
    await say(bot, chatId, statusMsgId, format`❌ не получилось, попробуй ещё раз`);
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
    await say(bot, chatId, statusMsgId, format`❌ не получилось, попробуй ещё раз`);
    return;
  }

  const track = current?.track;
  if (!track) {
    await say(bot, chatId, statusMsgId, format`🎵 сейчас ничего не играет`);
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

const GROUP_HINT = "в группах работаю через inline — набери @nowymbot название. настройки и вход — в личке";
const PRIVATE_HINT =
  "так не ищу 🙂 набери @nowymbot название — в любом чате. в личку можно кидать ссылки на трек, альбом или плейлист. остальное — /help";

const isGroupChat = (type: string | undefined): boolean => type === "group" || type === "supergroup";

export function registerCommon(bot: Bot, container: Container): void {
  bot.command("start", async (ctx) => {
    if (isGroupChat(ctx.chat?.type)) {
      await ctx.reply(GROUP_HINT);
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
      await ctx.reply(GROUP_HINT);
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
    const status = await ctx.reply(format`⏳ ищу что играет...`);
    await renderNowPlaying(bot, ctx.chat.id, ctxUser(ctx), container, status.id);
  });
}

/** замыкающий обработчик: личка, обычный текст (не команда) — подсказка вместо тишины.
 *  Регистрировать ПОСЛЕ всех hears/command, иначе перехватит ссылки и команды. */
export function registerPrivateFallback(bot: Bot): void {
  bot.on("message", async (ctx, next) => {
    const text = ctx.text;
    if (ctx.chat?.type !== "private" || !text || text.startsWith("/") || ctx.viaBot) return next();
    await ctx.reply(PRIVATE_HINT);
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
    const status = await bot.api.sendMessage({ chat_id: chatId, text: format`⏳ ищу трек...` });
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
