import type { Bot } from "gramio";
import type { Container } from "../../container.ts";
import { onCardRetryCallback, onLikeCallback, onLoadCallback } from "./callbacks.ts";
import { onChosenResult } from "./chosen.ts";
import { onInlineQuery } from "./query.ts";

export { type CardPosition, sendTrackToChat } from "./chat.ts";
export { chosenRichCardTrack, onChosenResult } from "./chosen.ts";
export { type EnsureResult, ensureFileId } from "./ensure.ts";
export { buildEmptyResults, injectRichSearchCards, injectTrackLinkCards } from "./query.ts";
export { buildChosenEditPayload, chatAudioExtras, EMPTY_ANSWER_PARAMS, parseTrackResultId } from "./shared.ts";

export function registerInline(bot: Bot, container: Container): void {
  bot.inlineQuery(/[\s\S]*/, (ctx) => onInlineQuery(ctx as never, container));
  bot.chosenInlineResult(/[\s\S]*/, (ctx) => onChosenResult(ctx as never, container, bot));
  bot.callbackQuery(/^load:/, (ctx) => onLoadCallback(ctx as never, container, bot));
  bot.callbackQuery(/^like:/, (ctx) => onLikeCallback(ctx as never, container));
  bot.callbackQuery(/^crd:/, (ctx) => onCardRetryCallback(ctx as never, container, bot));
}
