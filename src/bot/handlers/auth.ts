import { type DialogManager, StartMode } from "@gramio/dialogs";
import type { Bot } from "gramio";
import type { Container } from "../container.ts";
import { startLogin, startLogout } from "../dialogs.ts";

const dialogOf = (ctx: unknown): DialogManager => (ctx as { dialog: DialogManager }).dialog;

export function registerAuth(bot: Bot, container: Container): void {
  bot.command("login", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    const dialog = dialogOf(ctx);
    await dialog.start("menu", "main", { startMode: StartMode.ResetStack });
    await startLogin(dialog, bot, container, ctx.from!.id);
  });

  bot.command("logout", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    const dialog = dialogOf(ctx);
    await dialog.start("menu", "main", { startMode: StartMode.ResetStack });
    await startLogout(dialog, container, ctx.from!.id);
  });
}
