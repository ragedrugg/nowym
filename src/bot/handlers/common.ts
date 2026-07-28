import { type FormattableString, blockquote, bold, code, format, MediaUpload } from "gramio";
import type { Bot } from "gramio";
import { StartMode, type DialogManager } from "@gramio/dialogs";
import type { Container } from "../container.ts";
import { nowPlayingMarkup } from "../markup.ts";
import { getLogger } from "../../infra/logging.ts";
import { normalizeCoverUrl } from "../../yandex/media.ts";
import { buildCardMeta, formatTrackBasics } from "../../yandex/metadata.ts";
import { buildCardImage } from "../cardBuilder.ts";
import { senderHandleOf } from "../captions.ts";
import { say } from "../safeApi.ts";
import { sendTrackToChat } from "./inline.ts";
import { startAlbumUpload } from "./albums.ts";

/** ResetStack: дефолтный Normal пушил бы новый диалог на стек на каждый /start|/help|/settings,
 *  и кнопки прежних меню «протухали бы». */
async function startMenu(ctx: unknown, state: string): Promise<void> {
  await (ctx as { dialog: DialogManager }).dialog.start("menu", state, { startMode: StartMode.ResetStack });
}

const log = getLogger("bot.common");

const START_ALBUM_RE = /^album_(\d+)$/;
const START_TRACK_RE = /^track_(\d+)$/;

export interface TgUser {
  id: number;
  username?: string | null;
  firstName?: string | null;
}

export function startText(loggedIn: boolean): FormattableString {
  const base = format`привет 👋\n\nэто бот для одного жёлтого музыкального сервиса. кидает треки прямо в телеграм — по названию, по ссылке или просто тот, который у тебя сейчас играет\n\n`;
  const tail = loggedIn ? "жми кнопки или пиши команды" : "для начала войди в аккаунт";
  return format`${base}${tail}`;
}

export function helpText(): FormattableString {
  return format`🎵 ${bold("что я умею")}
кидаю треки и альбомы прямо в телеграм — по названию, ссылке, цитате из песни или тот, что играет у тебя сейчас.

⌨️ ${bold("inline — в любом чате")}
набери ${code("@nowymbot")} и через пробел:
${blockquote(format`${code("название")} — поиск треков и альбомов
${code("ссылка")} — трек или альбом по ссылке
${code("(пусто)")} — что играет сейчас + карточка
${code('"строка из песни"')} — поиск по цитате + текст
${code("недавнее")} — история прослушиваний (листается)
${code("ncore / speed / slow")} — эффекты: nightcore / спидап / slowed+reverb`)}

💬 ${bold("в личке")}
${blockquote(format`${code("/np")} — карточка трека, что играет сейчас
ссылка на альбом, подкаст или аудиокнигу — выгружу треки сюда
${code("/settings")} — настройки выдачи
${code("/login")} · ${code("/logout")} — вход и выход`)}`;
}

/** общий гейт для карточки и аудио: statusMsgId отличается у каждого вызывающего. */
async function checkLimitAndToken(
  bot: Bot, chatId: number, user: TgUser, container: Container, statusMsgId: number | null,
): Promise<string | null> {
  const [allowed, retryAfter] = container.downloadLimiter.check(user.id);
  if (!allowed) {
    await say(bot, chatId, statusMsgId, format`⏳ слишком часто, подожди ${Math.round(retryAfter)} сек`);
    return null;
  }
  const token = await container.resolveToken(user.id);
  if (!token) {
    await say(bot, chatId, statusMsgId, format`сначала войди — /login или жми 🔐 в меню`);
    return null;
  }
  return token;
}

/** лимит — общий с /np. */
export async function renderNowPlaying(
  bot: Bot,
  chatId: number,
  user: TgUser,
  container: Container,
  statusMsgId: number | null,
): Promise<void> {
  const token = await checkLimitAndToken(bot, chatId, user, container, statusMsgId);
  if (!token) return;

  try {
    const yandex = await container.getYandexService(token, user.id);
    const current = await yandex.getCurrentTrack();
    const track = current.track;
    if (!track) {
      await say(bot, chatId, statusMsgId, format`🎵 сейчас ничего не играет`);
      return;
    }

    const [artist, title] = formatTrackBasics(track, "");
    const senderHandle = senderHandleOf(user);
    const settings = await container.getUserSettings(user.id);

    const image = await buildCardImage({
      bot,
      container,
      userId: user.id,
      token,
      coverUrl: normalizeCoverUrl(track.coverUri ?? "", "1000x1000"),
      title,
      artist,
      progressMs: current.progress_ms ?? 0,
      durationMs: current.duration_ms ?? 0,
      paused: Boolean(current.paused),
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
    log.error(`[np] ошибка user=${user.id}: ${e}`);
    await say(bot, chatId, statusMsgId, format`❌ не получилось, попробуй ещё раз`);
  }
}

/** лимит общий с /np. */
export async function sendCurrentTrack(
  bot: Bot,
  chatId: number,
  user: TgUser,
  container: Container,
  statusMsgId: number | null,
): Promise<void> {
  const token = await checkLimitAndToken(bot, chatId, user, container, statusMsgId);
  if (!token) return;

  let track;
  try {
    const yandex = await container.getYandexService(token, user.id);
    const current = await yandex.getCurrentTrack();
    track = current.track;
  } catch (e) {
    log.error(`[current] ошибка user=${user.id}: ${e}`);
    await say(bot, chatId, statusMsgId, format`❌ не получилось, попробуй ещё раз`);
    return;
  }

  if (!track) {
    await say(bot, chatId, statusMsgId, format`🎵 сейчас ничего не играет`);
    return;
  }

  await sendTrackToChat({
    bot, chatId, userId: user.id, container,
    trackId: String(track.id), trackObj: track, token, statusMsgId, checkLimit: false,
  });
}

function ctxUser(ctx: { from?: TgUser | null }): TgUser {
  if (!ctx.from) throw new Error("ctx.from отсутствует");
  return ctx.from;
}

export function registerCommon(bot: Bot, container: Container): void {
  bot.command("start", async (ctx) => {
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
        await startTrackUploadReply(bot, ctx.chat.id, user.id, mt[1]!, container);
        return;
      }
    }
    await startMenu(ctx, "main");
  });

  bot.command("help", async (ctx) => {
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

async function startTrackUploadReply(
  bot: Bot,
  chatId: number,
  userId: number,
  trackId: string,
  container: Container,
): Promise<void> {
  const status = await bot.api.sendMessage({ chat_id: chatId, text: format`⏳ ищу трек...` });
  await sendTrackToChat({ bot, chatId, userId, container, trackId, statusMsgId: status.message_id ?? null });
}
