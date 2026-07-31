import type { Bot } from "gramio";
import type { Container } from "../container.ts";
import { registerAdmin } from "./admin.ts";
import { registerAlbums } from "./albums.ts";
import { registerAuth } from "./auth.ts";
import { registerCommon } from "./common.ts";
import { registerInline } from "./inline.ts";
import { registerPlaylists } from "./playlists.ts";

/** порядок важен: команды и точечные callback'и раньше catch-all'ов
 * (inline-query / album-hears / playlist-hears). GramIO — первый подошедший
 * matcher выигрывает. */
export function registerHandlers(bot: Bot, container: Container): void {
  registerCommon(bot, container);
  registerAuth(bot, container);
  registerAdmin(bot, container);
  registerAlbums(bot, container);
  registerPlaylists(bot, container);
  registerInline(bot, container);
}
