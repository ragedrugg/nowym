/** меню команд бота (setMyCommands). */
import type { Bot } from "gramio";
import { getLogger } from "../infra/logging.ts";
import { getSettings } from "../settings.ts";

const log = getLogger("bot.commands_menu");

const PUBLIC_COMMANDS = [
  { command: "start", description: "приветствие" },
  { command: "help", description: "как пользоваться" },
  { command: "np", description: "карточка текущего трека" },
  { command: "settings", description: "настройки" },
  { command: "login", description: "войти в аккаунт" },
  { command: "logout", description: "выйти из аккаунта" },
];

const ADMIN_COMMANDS = [
  { command: "health", description: "статус и диагностика" },
  { command: "broadcast", description: "рассылка всем" },
];

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
