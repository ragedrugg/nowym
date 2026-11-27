import type { Container } from "../../container.ts";
import { type AppBot, tgUserOf } from "../../types.ts";
import { onCardRetryCallback, onLikeCallback, onLoadCallback } from "./callbacks.ts";
import { onChosenResult } from "./chosen.ts";
import { onInlineQuery } from "./query.ts";

export { type CardPosition, sendTrackToChat } from "./chat.ts";
export { chosenRichCardTrack, onChosenResult } from "./chosen.ts";
export { type EnsureResult, ensureFileId } from "./ensure.ts";
export { buildEmptyResults, injectRichSearchCards, injectTrackLinkCards } from "./query.ts";
export { buildChosenEditPayload, chatAudioExtras, EMPTY_ANSWER_PARAMS, parseTrackResultId } from "./shared.ts";

type AnswerParams = string | { text?: string; show_alert?: boolean };

/** Граница фреймворка: контекст yaebal несёт сырые поля Bot API (snake_case:
 * result_id, inline_message_id, from.first_name), а обработчики ниже работают с
 * нейтральными camelCase-формами — маппинг ровно здесь и больше нигде. */
export function registerInline(bot: AppBot, container: Container): void {
  // у yaebal нет inlineQuery()/chosenInlineResult()-роутеров; GramIO-регэксп /[\s\S]*/ матчил всё
  bot.on("inline_query", (ctx) =>
    onInlineQuery(
      {
        from: tgUserOf(ctx.from),
        query: ctx.query,
        offset: ctx.offset,
        answer: (results, params) => ctx.answer(results as never, params as never),
      },
      container,
    ),
  );
  bot.on("chosen_inline_result", (ctx) =>
    onChosenResult(
      {
        from: tgUserOf(ctx.from),
        resultId: ctx.result_id,
        inlineMessageId: ctx.inline_message_id ?? null,
        query: ctx.query,
      },
      container,
      bot,
    ),
  );
  const cb = (ctx: {
    from: { id: number };
    data?: string;
    inline_message_id?: string;
    answer(params?: AnswerParams): Promise<unknown>;
  }) => ({
    from: { id: ctx.from.id },
    data: ctx.data ?? "",
    inlineMessageId: ctx.inline_message_id ?? null,
    answer: (params?: AnswerParams) => ctx.answer(params as never),
  });
  bot.callbackQuery(/^load:/, (ctx) => onLoadCallback(cb(ctx), container, bot));
  bot.callbackQuery(/^like:/, (ctx) => onLikeCallback(cb(ctx), container));
  bot.callbackQuery(/^crd:/, (ctx) => onCardRetryCallback(cb(ctx), container, bot));
}
