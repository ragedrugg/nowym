/** меню команд бота (setMyCommands). */
import type { Bot } from "gramio";
import { getLogger } from "../infra/logging.ts";
import { getSettings } from "../settings.ts";
import { ADMIN_COMMANDS, PUBLIC_COMMANDS } from "./texts.ts";

const log = getLogger("bot.commands_menu");

export async function registerCommands(bot: Bot): Promise<void> {
  const s = getSettings();
  await bot.api.setMyCommands({
    commands: PUBLIC_COMMANDS,
    scope: { type: "all_private_chats" },
  });
  if (s.ADMIN_USER_ID) {
    await bot.api.setMyCommands({
      commands: [...PUBLIC_COMMANDS, ...ADMIN_COMMANDS],
      scope: { type: "chat", chat_id: s.ADMIN_USER_ID },
    });
  }
  log.info("меню команд зарегистрировано");
}
