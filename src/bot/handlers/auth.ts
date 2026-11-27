import type { Container } from "../container.ts";
import { startLogin, startLogout, startMenu } from "../dialogs.ts";
import type { AppBot } from "../types.ts";

export function registerAuth(bot: AppBot, container: Container): void {
  bot.command("login", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    await startMenu(ctx, container, "main");
    await startLogin(ctx.dialog, bot, container, ctx.from!.id);
  });

  bot.command("logout", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    await startMenu(ctx, container, "main");
    await startLogout(ctx.dialog, container, ctx.from!.id);
  });
}
