import { format } from "gramio";
import type { Bot } from "gramio";
import type { Container } from "../container.ts";
import { getLogger } from "../../infra/logging.ts";
import { pluralTracks } from "../../infra/text.ts";
import { ProgressMessage } from "../../services/albums.ts";
import { albumHeader } from "./albums.ts";

const log = getLogger("bot.playlists");

// owner — логин/uid Яндекса, реальный чарсет [A-Za-z0-9._-]; более широкий
// класс ([^/\s]+) пропускал бы ?/#/пробелоподобное внутрь URL, который
// собирается конкатенацией в lib.usersPlaylists() (client.ts.getPlaylist).
const PLAYLIST_URL_RE = /music\.yandex(?:\.ru)?\/users\/([\w.-]+)\/playlists\/(\d+)/;

/** зовут из бросания ссылки на плейлист боту в личку. */
export async function startPlaylistUpload(
  bot: Bot,
  chatId: number,
  userId: number,
  owner: string,
  kind: number,
  container: Container,
): Promise<void> {
  const [allowed, retryAfter] = container.downloadLimiter.check(userId);
  if (!allowed) {
    await bot.api.sendMessage({ chat_id: chatId, text: format`⏳ слишком часто, подожди ${Math.round(retryAfter)} сек` });
    return;
  }

  const token = await container.resolveToken(userId);
  if (!token) {
    await bot.api.sendMessage({ chat_id: chatId, text: "сначала войди через /login" });
    return;
  }

  // слот занимаем до await'ов — та же гонка, что и с альбомами (AlbumService общий)
  if (!container.albumService.tryBegin(userId)) {
    await bot.api.sendMessage({ chat_id: chatId, text: "у тебя уже идёт выгрузка — дождись её или нажми «отмена»" });
    return;
  }
  let handedOff = false;
  try {
    const progress = await bot.api.sendMessage({ chat_id: chatId, text: format`⏳ ищу плейлист...` });
    const progressMsg = new ProgressMessage(bot, chatId, progress.message_id);

    const yandex = await container.getYandexService(token, userId);
    const playlist = await yandex.getPlaylist(owner, kind);

    if (!playlist) {
      await progressMsg.edit(format`❌ плейлист не найден, недоступен или пуст`);
      return;
    }

    const trackCount = playlist.tracks.length;
    const caption = albumHeader("Плейлист", playlist.title, pluralTracks(trackCount), playlist.album_type);

    const coverBytes = await container.albumService.sendCover(chatId, playlist.cover_url, caption);
    await progressMsg.edit(format`${caption}\n\nзагружаю ${pluralTracks(trackCount)}...`);

    handedOff = true; // дальше слот ведёт sendAlbumTracks (его finally чистит active)
    await container.albumService.sendAlbum({
      chatId,
      userId,
      albumData: playlist,
      progressMsg,
      yandex,
      coverBytes,
    });
  } finally {
    if (!handedOff) container.albumService.release(userId);
  }
}

export function registerPlaylists(bot: Bot, container: Container): void {
  bot.hears(PLAYLIST_URL_RE, async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    const m = PLAYLIST_URL_RE.exec(ctx.text ?? "");
    if (!m) return;
    await startPlaylistUpload(bot, ctx.chat.id, ctx.from!.id, m[1]!, Number(m[2]), container);
  });

  log.debug("playlist-хендлеры зарегистрированы");
}
