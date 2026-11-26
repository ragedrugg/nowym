import type { Bot } from "gramio";
import { bold, type FormattableString, format } from "gramio";
import { getLogger } from "../../infra/logging.ts";
import { parseSearchQuery } from "../../infra/parsers.ts";
import { pluralTracks } from "../../infra/text.ts";
import { ProgressMessage } from "../../services/albums.ts";
import type { YandexClient } from "../../yandex/client.ts";
import { albumEmoji, albumTypeRu, LABELED_ALBUM_TYPES } from "../../yandex/metadata.ts";
import type { AlbumData } from "../../yandex/types.ts";
import type { Container } from "../container.ts";
import { cbData } from "../ctxutil.ts";
import { LOGIN_FIRST } from "../markup.ts";
import { startTrackUploadReply } from "./common.ts";

const log = getLogger("bot.albums");

function albumHeader(artist: string, title: string, metaLine: string, albumType: string): FormattableString {
  const head = format`${albumEmoji(albumType)} ${bold(`${artist} — ${title}`)}`;
  return metaLine ? format`${head}\n${metaLine}` : head;
}

/** общий поток выгрузки альбома и плейлиста: гейт → фетч → обложка → треки.
 *  Отличаются только фетчем и текстами — плейлист приходит той же AlbumData
 *  (buildPlaylistAlbumData), так что и мета-строку получает ту же. */
export async function startUpload(
  bot: Bot,
  chatId: number,
  userId: number,
  container: Container,
  /** им. падеж, он же вин.: «альбом» / «плейлист» — для «⏳ ищу …». */
  noun: string,
  notFoundText: FormattableString,
  fetch: (yandex: YandexClient) => Promise<AlbumData | null>,
): Promise<void> {
  const [allowed, retryAfter] = container.downloadLimiter.check(userId);
  if (!allowed) {
    await bot.api.sendMessage({
      chat_id: chatId,
      text: format`⏳ слишком часто, подожди ${Math.round(retryAfter)} сек`,
    });
    return;
  }

  const token = await container.resolveToken(userId);
  if (!token) {
    await bot.api.sendMessage({ chat_id: chatId, text: LOGIN_FIRST });
    return;
  }

  // слот занимаем до await'ов — иначе две выгрузки подряд устроят гонку active
  if (!container.albumService.tryBegin(userId)) {
    await bot.api.sendMessage({
      chat_id: chatId,
      text: "у тебя уже идёт выгрузка — дождись или жми «отменить»",
    });
    return;
  }
  let handedOff = false;
  let progressMsg: ProgressMessage | null = null;
  try {
    const progress = await bot.api.sendMessage({ chat_id: chatId, text: format`⏳ ищу ${noun}...` });
    progressMsg = new ProgressMessage(bot, chatId, progress.message_id);

    const yandex = await container.getYandexService(token, userId);
    const album = await fetch(yandex);

    if (!album) {
      await progressMsg.edit(notFoundText);
      return;
    }

    const trackCount = album.tracks.length;
    if (trackCount === 0) {
      await progressMsg.edit(format`❌ нет доступных треков`);
      return;
    }
    const metaParts = [album.year, album.label, pluralTracks(trackCount)].filter(Boolean) as string[];
    const typeKey = album.album_type.toLowerCase();
    if (LABELED_ALBUM_TYPES.has(typeKey)) {
      const typeLabel = albumTypeRu(album.album_type, trackCount);
      if (typeLabel) metaParts.unshift(typeLabel);
    }
    const metaLine = metaParts.join(", ");
    const caption = albumHeader(album.artist, album.title, metaLine, album.album_type);

    const coverBytes = await container.albumService.sendCover(chatId, album.cover_url, caption);
    await progressMsg.edit(format`${caption}\n\nзагружаю ${pluralTracks(trackCount)}...`);

    handedOff = true; // дальше слот ведёт sendAlbumTracks (его finally чистит active)
    await container.albumService.sendAlbum({
      chatId,
      userId,
      albumData: album,
      progressMsg,
      yandex,
      coverBytes,
    });
  } catch (e) {
    log.error(`[${noun}] ошибка user=${userId}: ${e}`);
    // после передачи слота sendAlbum сам разбирается со своими ошибками
    if (!handedOff && progressMsg) await progressMsg.edit(format`❌ ошибка, попробуй ещё раз`).catch(() => {});
  } finally {
    if (!handedOff) container.albumService.release(userId);
  }
}

/** зовут и из /start album_<id>, и из URL в личке. */
export async function startAlbumUpload(
  bot: Bot,
  chatId: number,
  userId: number,
  albumId: number,
  container: Container,
): Promise<void> {
  await startUpload(bot, chatId, userId, container, "альбом", format`❌ альбом не найден или недоступен`, (yandex) =>
    yandex.getAlbum(albumId),
  );
}

export function registerAlbums(bot: Bot, container: Container): void {
  // ссылки на альбом и трек; плейлист — отдельный hears в playlists.ts
  bot.hears(
    (ctx) => {
      const t = parseSearchQuery(ctx.text ?? "").type;
      return t === "album_link" || t === "track_link";
    },
    async (ctx) => {
      if (ctx.chat?.type !== "private") return;
      const parsed = parseSearchQuery(ctx.text ?? "");
      const from = ctx.from!;
      if (parsed.type === "album_link") {
        await startAlbumUpload(bot, ctx.chat.id, from.id, parsed.album_id, container);
      } else if (parsed.type === "track_link") {
        const user = { id: from.id, username: from.username ?? null, firstName: from.firstName ?? null };
        await startTrackUploadReply(bot, ctx.chat.id, user, String(parsed.track_id), container);
      }
    },
  );

  bot.callbackQuery("cancel_album", async (ctx) => {
    const cancelled = container.albumService.cancel(ctx.from.id);
    await ctx.answer(cancelled ? "отмена..." : "нечего отменять");
  });

  bot.callbackQuery(/^album_retry:/, async (ctx) => {
    const msgId = Number(cbData(ctx).split(":", 2)[1]);
    if (!Number.isFinite(msgId)) {
      await ctx.answer({ text: "что-то пошло не так", show_alert: true });
      return;
    }

    // peek, не take: до всех проверок буфер не трогаем — иначе чужой тап (или
    // тап мимо владельца) сжирал бы retry чужого альбома без права на него.
    const peeked = container.albumService.peekRetry(msgId);
    if (!peeked) {
      await ctx.answer({ text: "слишком поздно — кинь ссылку ещё раз", show_alert: true });
      return;
    }
    if (peeked.userId !== ctx.from.id) {
      await ctx.answer({ text: "это не твоя выгрузка", show_alert: true });
      return;
    }

    // isActive тут — только быстрый предварительный отсев для UX (не тратить
    // popRetry впустую на очевидно занятый слот). Настоящая атомарная проверка —
    // внутри retryFailed (tryBegin синхронно, до наших await'ов ниже).
    if (container.albumService.isActive(peeked.userId)) {
      await ctx.answer({ text: "у тебя уже идёт выгрузка", show_alert: true });
      return;
    }

    // все проверки прошли — теперь забираем буфер по-настоящему
    const buf = container.albumService.popRetry(msgId);
    if (!buf) {
      await ctx.answer({ text: "слишком поздно — кинь ссылку ещё раз", show_alert: true });
      return;
    }

    const progressMsg = ctx.message ? new ProgressMessage(bot, ctx.message.chat.id, ctx.message.id) : null;
    const started = await container.albumService.retryFailed({
      chatId: buf.chatId,
      userId: buf.userId,
      tracks: buf.tracks,
      albumData: buf.albumData,
      progressMsg,
      yandex: buf.yandex,
    });
    await ctx.answer(started ? "повторяю..." : { text: "у тебя уже идёт выгрузка", show_alert: true });
  });

  log.debug("album-хендлеры зарегистрированы");
}
