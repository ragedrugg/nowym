import type { Bot } from "gramio";
import { format } from "gramio";
import { getLogger } from "../../infra/logging.ts";
import { PLAYLIST_URL_RE } from "../../infra/parsers.ts";
import type { Container } from "../container.ts";
import { startUpload } from "./albums.ts";

const log = getLogger("bot.playlists");

/** зовут и из /start playlist_<owner>_<kind>, и из ссылки в личке. */
export async function startPlaylistUpload(
  bot: Bot,
  chatId: number,
  userId: number,
  owner: string,
  kind: number,
  container: Container,
): Promise<void> {
  await startUpload(
    bot,
    chatId,
    userId,
    container,
    "плейлист",
    format`❌ плейлист не найден, недоступен или пуст`,
    (yandex) => yandex.getPlaylist(owner, kind),
  );
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
