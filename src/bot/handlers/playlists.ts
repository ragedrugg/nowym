import type { Bot } from "gramio";
import { format } from "gramio";
import { getLogger } from "../../infra/logging.ts";
import { PLAYLIST_URL_RE } from "../../infra/parsers.ts";
import type { Container } from "../container.ts";
import { startUpload } from "./albums.ts";

const log = getLogger("bot.playlists");

/** зовут и из /start playlist_<id>, и из ссылки в личке. У Spotify owner в
 *  URL нет — оставлен как пустая строка для совместимости сигнатуры. */
export async function startPlaylistUpload(
  bot: Bot,
  chatId: number,
  userId: number,
  _owner: string,
  kind: string,
  container: Container,
): Promise<void> {
  await startUpload(
    bot,
    chatId,
    userId,
    container,
    "плейлист",
    format`❌ плейлист не найден, недоступен или пуст`,
    (music) => music.getPlaylist("", kind),
  );
}

export function registerPlaylists(bot: Bot, container: Container): void {
  bot.hears(PLAYLIST_URL_RE, async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    const m = PLAYLIST_URL_RE.exec(ctx.text ?? "");
    if (!m) return;
    await startPlaylistUpload(bot, ctx.chat.id, ctx.from!.id, "", m[1]!, container);
  });

  log.debug("playlist-хендлеры зарегистрированы");
}
