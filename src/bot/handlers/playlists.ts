import { format } from "yaebal";
import { getLogger } from "../../infra/logging.ts";
import { PLAYLIST_URL_RE, PLAYLIST_UUID_URL_RE } from "../../infra/parsers.ts";
import type { Container } from "../container.ts";
import { PLAYLIST_NOT_FOUND, PLAYLIST_NOUN } from "../texts.ts";
import type { ApiBot, AppBot } from "../types.ts";
import { startUpload } from "./albums.ts";

const log = getLogger("bot.playlists");

/** зовут и из /start playlist_<owner>_<kind>, и из ссылки в личке. */
export async function startPlaylistUpload(
  bot: ApiBot,
  chatId: number,
  userId: number,
  owner: string,
  kind: number,
  container: Container,
): Promise<void> {
  await startUpload(bot, chatId, userId, container, PLAYLIST_NOUN, format`${PLAYLIST_NOT_FOUND}`, (yandex) =>
    yandex.getPlaylist(owner, kind, { strict: true }),
  );
}

export function registerPlaylists(bot: AppBot, container: Container): void {
  // on("message"), не hears: yaebal-hears матчит и edited_message (см. albums.ts)
  bot.on("message", async (ctx, next) => {
    if (!PLAYLIST_URL_RE.test(ctx.text ?? "")) return next();
    if (ctx.chat?.type !== "private") return;
    const m = PLAYLIST_URL_RE.exec(ctx.text ?? "");
    if (!m) return;
    await startPlaylistUpload(bot, ctx.chat.id, ctx.from!.id, m[1]!, Number(m[2]), container);
  });

  // ссылка «поделиться» (/playlists/<uuid>): резолвим в (uid, kind) и идём обычным путём плейлиста
  bot.on("message", async (ctx, next) => {
    if (!PLAYLIST_UUID_URL_RE.test(ctx.text ?? "")) return next();
    if (ctx.chat?.type !== "private") return;
    const m = PLAYLIST_UUID_URL_RE.exec(ctx.text ?? "");
    if (!m) return;
    const uuid = m[1]!.toLowerCase();
    await startUpload(
      bot,
      ctx.chat.id,
      ctx.from!.id,
      container,
      PLAYLIST_NOUN,
      format`${PLAYLIST_NOT_FOUND}`,
      async (yandex) => {
        const ref = await yandex.resolvePlaylistUuid(uuid, { strict: true });
        return ref ? yandex.getPlaylist(ref.owner, ref.kind, { strict: true }) : null;
      },
    );
  });

  log.debug("playlist-хендлеры зарегистрированы");
}
