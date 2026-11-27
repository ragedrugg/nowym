import type { Bot } from "gramio";
import { getLogger } from "../../../infra/logging.ts";
import type { AudioQuality } from "../../../yandex/metadata.ts";
import type { Container } from "../../container.ts";
import { cbData } from "../../ctxutil.ts";
import { progressMarkup, retryMarkup, type trackMarkup } from "../../markup.ts";
import { safeAnswerCb, safeEditMedia, safeSetReplyMarkup } from "../../safeApi.ts";
import {
  BTN_DOWNLOADING,
  BTN_PREPARING,
  CB_FAILED,
  CB_FIND_AGAIN,
  CB_LIKED,
  CB_UNLIKED,
  CB_WAIT,
  cbNotYourTrack,
  ensureErrorButton,
  LOGIN_FIRST,
  tooOftenButton,
} from "../../texts.ts";
import { isCardResultId, peekCardPending, renderAndSwapCard } from "../inlineCard.ts";
import { ensureFileId, resolveTrack } from "./ensure.ts";
import {
  type AudioEditMedia,
  buildChosenEditPayload,
  DownloadRateLimited,
  downloadLimitGate,
  reissueEdit,
} from "./shared.ts";

const log = getLogger("bot.inline");

/** (user, track), у которых лайк-тоггл в полёте: параллельные тапы иначе ставят и тут же снимают. */
const likesInFlight = new Set<string>();

export async function onLoadCallback(
  ctx: {
    inlineMessageId?: string | null;
    from: { id: number };
    answer(params?: string | { text?: string; show_alert?: boolean }): Promise<unknown>;
  },
  container: Container,
  bot: Bot,
): Promise<void> {
  const data = cbData(ctx);
  const raw = data.includes(":") ? (data.split(":", 2)[1] ?? "") : "";
  if (!/^\d+$/.test(raw)) {
    await safeAnswerCb(ctx, { text: CB_FIND_AGAIN, show_alert: true });
    return;
  }
  const trackId = raw;
  const inlineMsgId = ctx.inlineMessageId ?? null;
  const userId = ctx.from.id;

  if (!inlineMsgId) {
    await safeAnswerCb(ctx, { text: CB_FIND_AGAIN, show_alert: true });
    return;
  }

  // в группе кнопку видят все, рулить может только владелец инлайна;
  // владелец неизвестен (рестарт/эвикт) → пропускаем (мягкая деградация)
  const owner = container.inlineOwners.get(inlineMsgId);
  if (owner !== null && owner !== userId) {
    log.info(`[load] чужой инлайн: tapper=${userId} owner=${owner} track=${trackId}`);
    await safeAnswerCb(ctx, {
      text: cbNotYourTrack(container.botUsername),
      show_alert: true,
    });
    return;
  }

  const token = await container.resolveToken(userId);
  if (!token) {
    await safeAnswerCb(ctx, { text: LOGIN_FIRST, show_alert: true });
    return;
  }

  // отвечаем на callback сразу (иначе кнопка крутится до таймаута), итог — сменой кнопок.
  // лимитер в onDownloadStart: готовый кэш лимит не тратит; дедуп закачек живёт в cacheService.
  await safeAnswerCb(ctx, BTN_DOWNLOADING);
  let finalEdit: { media: AudioEditMedia; markup: ReturnType<typeof trackMarkup> | undefined } | null = null;
  try {
    const { cached, trackObj, yandex, unavailable } = await resolveTrack(container, token, userId, trackId);
    const settings = await container.getUserSettings(userId);
    const quality = settings.track_quality as AudioQuality;
    // эффект берём из запроса, запомненного на chosen_result: в callback_data его нет,
    // а «качаю...»/«загрузить снова» обязаны отдать тот же вариант, что просили.
    const tier = container.inlineEffects.get(inlineMsgId);
    const res = await ensureFileId(container, cached, trackObj, yandex, trackId, {
      quality,
      tier,
      unavailable,
      onDownloadStart: async () => {
        await downloadLimitGate(container, userId)();
        await safeSetReplyMarkup(bot, inlineMsgId, progressMarkup(trackId, BTN_DOWNLOADING));
      },
    });
    if (!res.ok) {
      const text = ensureErrorButton(res.kind);
      await safeSetReplyMarkup(bot, inlineMsgId, text ? progressMarkup(trackId, text) : retryMarkup(trackId));
      return;
    }
    const { fileId, codec, bitrateKbps, degraded } = res;
    const layout = settings.track_layout;
    const { media, markup } = buildChosenEditPayload({ trackId, fileId, codec, bitrateKbps, layout, degraded });
    finalEdit = { media, markup };
    await safeEditMedia(bot, { inlineMessageId: inlineMsgId }, media, markup);
    log.info(`[load] трек ${trackId} загружен user=${userId}${degraded ? " (FLAC→mp3)" : ""}`);
  } catch (e) {
    if (e instanceof DownloadRateLimited) {
      await safeSetReplyMarkup(bot, inlineMsgId, progressMarkup(trackId, tooOftenButton(e.retryAfterSec)));
      return;
    }
    log.error(`[load] ошибка user=${userId} track=${trackId}: ${e}`);
    if (await reissueEdit(bot, inlineMsgId, finalEdit, e)) return;
    await safeSetReplyMarkup(bot, inlineMsgId, retryMarkup(trackId));
  }
}

/** `crd:<resultId>` — повтор рендера карточки (npc:/lyc:) после сбоя: перерисовывает
 * карточку, а не меняет её на аудио. Стэш протух → renderAndSwapCard сам даст load:. */
export async function onCardRetryCallback(
  ctx: {
    inlineMessageId?: string | null;
    from: { id: number };
    answer(params?: string | { text?: string; show_alert?: boolean }): Promise<unknown>;
  },
  container: Container,
  bot: Bot,
): Promise<void> {
  const resultId = cbData(ctx).slice("crd:".length);
  const inlineMsgId = ctx.inlineMessageId ?? null;
  if (!isCardResultId(resultId) || !inlineMsgId) {
    await safeAnswerCb(ctx, { text: CB_FIND_AGAIN, show_alert: true });
    return;
  }
  // кнопку в группе видят все: перерисовать может только тот, чья это карточка
  const payload = peekCardPending(resultId);
  if (payload !== null && payload.userId !== ctx.from.id) {
    await safeAnswerCb(ctx, { text: cbNotYourTrack(container.botUsername), show_alert: true });
    return;
  }
  await safeAnswerCb(ctx, BTN_PREPARING);
  await renderAndSwapCard(bot, container, resultId, inlineMsgId, ctx.from.id);
}

/** кнопка статична (❤️ без состояния) — клаву не перерисовываем, результат тостом. */
export async function onLikeCallback(
  ctx: {
    from: { id: number };
    answer(params?: string | { text?: string; show_alert?: boolean }): Promise<unknown>;
  },
  container: Container,
): Promise<void> {
  const parts = cbData(ctx).split(":");
  const raw = parts[2] ?? "";
  if (!/^\d+$/.test(raw)) {
    await safeAnswerCb(ctx, { text: CB_FAILED, show_alert: true });
    return;
  }
  const trackId = raw;
  const userId = ctx.from.id;

  const token = await container.resolveToken(userId);
  if (!token) {
    await safeAnswerCb(ctx, { text: LOGIN_FIRST, show_alert: true });
    return;
  }

  const flightKey = `${userId}:${trackId}`;
  if (likesInFlight.has(flightKey)) {
    await safeAnswerCb(ctx, CB_WAIT);
    return;
  }
  likesInFlight.add(flightKey);
  try {
    const yandex = await container.getYandexService(token, userId);
    // strict: при сбое получения списка не гадаем «не лайкнут» — иначе ставим лайк поверх уже стоящего
    const liked = await yandex.isTrackLiked(trackId, true);
    const ok = await yandex.setTrackLiked(trackId, !liked);
    if (!ok) {
      await safeAnswerCb(ctx, { text: CB_FAILED, show_alert: true });
      return;
    }
    await safeAnswerCb(ctx, !liked ? CB_LIKED : CB_UNLIKED);
  } catch (e) {
    log.error(`[like] ошибка user=${userId} track=${trackId}: ${e}`);
    await safeAnswerCb(ctx, { text: CB_FAILED, show_alert: true });
  } finally {
    likesInFlight.delete(flightKey);
  }
}
