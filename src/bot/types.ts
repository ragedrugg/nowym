/** Общие типы бот-слоя. */
import type { DialogControl } from "@yaebal/morda";
import type { Api, Bot, Context, User } from "yaebal";

/** отправитель апдейта — ровно те поля, что нужны подписи/карточке. */
export interface TgUser {
  id: number;
  username?: string | null;
  firstName?: string | null;
}

/** сырой Bot API `User` (snake_case, как его отдаёт yaebal в ctx.from) → TgUser. */
export function tgUserOf(from: Pick<User, "id" | "username" | "first_name">): TgUser {
  return { id: from.id, username: from.username ?? null, firstName: from.first_name ?? null };
}

/** всё, чему нужен только bot.api (сервисы, safeApi, отправители). */
export interface ApiBot {
  api: Api;
}

/** контекст после установки morda-диалогов (ctx.dialog). */
export type AppContext = Context & { dialog: DialogControl };

/** бот с диалогами — на нём регистрируются хендлеры. */
export type AppBot = Bot<AppContext>;
