import type { Container } from "../container.ts";
import { DIALOG_PREFIX } from "../dialogs.ts";
import { safeAnswerCb } from "../safeApi.ts";
import type { AppBot } from "../types.ts";
import { registerAdmin } from "./admin.ts";
import { registerAlbums } from "./albums.ts";
import { registerAuth } from "./auth.ts";
import { registerCommon, registerPrivateFallback } from "./common.ts";
import { registerInline } from "./inline/index.ts";
import { registerPlaylists } from "./playlists.ts";

/** порядок важен: команды и точечные callback'и раньше catch-all'ов
 * (inline-query / ссылки альбомов и плейлистов). yaebal (как GramIO) — первый подошедший
 * matcher выигрывает. */
export function registerHandlers(bot: AppBot, container: Container): void {
  registerCommon(bot, container);
  registerAuth(bot, container);
  registerAdmin(bot, container);
  registerAlbums(bot, container);
  registerPlaylists(bot, container);
  registerInline(bot, container);
  registerPrivateFallback(bot, container); // строго последним: ловит только то, что не взял никто выше
  registerOrphanCallbackFallback(bot);
}

/** callback, который не взял ни один хендлер, — кнопки меню GramIO (`grd`-кодек), оставшиеся
 * в чатах после переезда на morda (`dlg:`), и прочие осиротевшие кнопки. GramIO-диалоги на
 * такие (стека нет) отвечали пустым answer — гасим спиннер так же, а не держим его 30 с.
 * dlg:-кнопки сюда не доходят пустыми: их гасит dialogAnswerGate. */
export function registerOrphanCallbackFallback(bot: AppBot): void {
  bot.on("callback_query", async (ctx) => {
    if (ctx.data?.startsWith(`${DIALOG_PREFIX}:`)) return;
    await safeAnswerCb(ctx);
  });
}
