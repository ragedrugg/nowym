/** Единые «безопасные» обёртки над bot.api и callback-контекстом.
 *
 * Одна политика подавления ожидаемых телеграм-ошибок редактирования (гонки:
 * «not modified», протухший inline-query, удалённое/нередактируемое сообщение). */
import type { Bot, FormattableString } from "gramio";
import { getLogger } from "../infra/logging.ts";

const log = getLogger("bot.safeapi");

type Text = FormattableString | string;
type Markup = unknown;

/** цель редактирования: обычное сообщение (chat+id) либо inline-сообщение. */
export type EditTarget = { chatId: number; messageId: number } | { inlineMessageId: string };

/** телеграм-ошибки редактирования, которые не считаем проблемой (ожидаемые гонки). */
const BENIGN = [
  "not modified",
  "query is too old",
  "message to edit not found",
  "message can't be edited",
  "message_id_invalid",
];

function isBenign(e: unknown): boolean {
  const s = String(e).toLowerCase();
  return BENIGN.some((m) => s.includes(m));
}

function targetParams(t: EditTarget): Record<string, unknown> {
  return "inlineMessageId" in t
    ? { inline_message_id: t.inlineMessageId }
    : { chat_id: t.chatId, message_id: t.messageId };
}

function markupParam(markup?: Markup): Record<string, unknown> {
  return markup ? { reply_markup: markup } : {};
}

/** editMessageText через bot.api; глотает ожидаемые гонки, остальное логирует warning. */
export async function safeEditApi(bot: Bot, target: EditTarget, text: Text, markup?: Markup): Promise<void> {
  try {
    await bot.api.editMessageText({ ...targetParams(target), text, ...markupParam(markup) } as never);
  } catch (e) {
    if (!isBenign(e)) log.warning(`[safeEdit] edit упал: ${e}`);
  }
}

/** как safeEditApi, но при неудачном edit шлёт НОВОЕ сообщение. Для отложенных
 * колбэков (device-flow): anchor может быть удалён за минуты ожидания, и тогда
 * edit молча терялся бы — юзер не узнал бы результат. */
export async function editOrSend(
  bot: Bot,
  anchor: { chatId: number; messageId: number },
  text: Text,
  markup?: Markup,
): Promise<void> {
  try {
    await bot.api.editMessageText({
      chat_id: anchor.chatId,
      message_id: anchor.messageId,
      text,
      ...markupParam(markup),
    } as never);
  } catch {
    try {
      await bot.api.sendMessage({ chat_id: anchor.chatId, text, ...markupParam(markup) } as never);
    } catch (e) {
      log.warning(`не вышло уведомить ${anchor.chatId}: ${e}`);
    }
  }
}

/** editMessageMedia; глотает «not modified», прочие ошибки пробрасывает наверх
 * (вызывающий уже логирует их в своём catch). */
export async function safeEditMedia(bot: Bot, target: EditTarget, media: unknown, markup?: Markup): Promise<void> {
  try {
    await bot.api.editMessageMedia({ ...targetParams(target), media, ...markupParam(markup) } as never);
  } catch (e) {
    if (isBenign(e)) {
      log.info("[safeEditMedia] уже актуально (not modified)");
      return;
    }
    throw e;
  }
}

/** editMessageReplyMarkup для inline-сообщения; best-effort, всё глотает. */
export async function safeSetReplyMarkup(bot: Bot, inlineMsgId: string, markup: Markup): Promise<void> {
  try {
    await bot.api.editMessageReplyMarkup({ inline_message_id: inlineMsgId, reply_markup: markup } as never);
  } catch {
    /* query too old / not modified */
  }
}

/** ответ на callback_query, не падающий на протухшем query («query is too old»). */
export async function safeAnswerCb(
  ctx: { answer(params?: string | { text?: string; show_alert?: boolean }): Promise<unknown> },
  params?: string | { text?: string; show_alert?: boolean },
): Promise<void> {
  try {
    await ctx.answer(params);
  } catch {
    /* query too old / invalid */
  }
}

/** статус-строка: правит существующее статус-сообщение, иначе шлёт новое. */
export async function say(bot: Bot, chatId: number, statusMsgId: number | null, text: Text): Promise<void> {
  if (statusMsgId !== null) {
    try {
      await bot.api.editMessageText({ chat_id: chatId, message_id: statusMsgId, text } as never);
      return;
    } catch {
      /* fall through → sendMessage */
    }
  }
  await bot.api.sendMessage({ chat_id: chatId, text } as never);
}
