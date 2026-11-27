import type { Bot } from "gramio";
import { createInterruptibleSleep, withTimeout } from "../../../infra/async.ts";
import { getLogger } from "../../../infra/logging.ts";
import { type AudioQuality, findBestLyricsLine, formatTrackBasics, trackIsTooLong } from "../../../yandex/metadata.ts";
import type { Container } from "../../container.ts";
import { progressMarkup, retryMarkup, trackMarkup } from "../../markup.ts";
import { errText, type RichAudio } from "../../richMessage.ts";
import { safeEditMedia, safeSetReplyMarkup } from "../../safeApi.ts";
import { BTN_DOWNLOADING, BTN_SENDING, LOGIN_FIRST, TOO_LONG_TEXT, tooOftenButton, YANDEX_DOWN } from "../../texts.ts";
import { isCardResultId, isRichResultId, peekCardPending, renderAndSwapCard, resolveRichCard } from "../inlineCard.ts";
import { type EnsureResult, ensureFileId, resolveTrack } from "./ensure.ts";
import {
  type AudioEditMedia,
  buildChosenEditPayload,
  DownloadRateLimited,
  downloadLimitGate,
  parseEffect,
  parseTrackResultId,
  reissueEdit,
} from "./shared.ts";

const log = getLogger("bot.inline");

async function fetchLyricsForQuery(
  container: Container,
  token: string,
  userId: number,
  trackId: string,
  searchPhrase: string,
  artist: string,
  title: string,
): Promise<string | null> {
  let raw: string | null = null;

  // 1) Genius по самой фразе — самый надёжный источник
  if (container.genius) {
    try {
      raw = await withTimeout(container.genius.lyricsForPhrase(searchPhrase), 8000);
    } catch (e) {
      log.warning(`[lyrics/genius-phrase] track=${trackId}: ${e}`);
    }
  }

  // 2) фолбэк: Genius по (artist, title) выбранного трека
  if (!raw && container.genius && artist && title) {
    try {
      raw = await withTimeout(container.genius.getLyrics(artist, title), 8000);
    } catch (e) {
      log.warning(`[lyrics/genius] track=${trackId}: ${e}`);
    }
  }

  if (!raw) {
    try {
      const svc = await container.getTrackService(token, userId);
      raw = await withTimeout(svc.yandexService.getTrackLyrics(trackId), 6000);
    } catch (e) {
      log.warning(`[lyrics/yandex] track=${trackId}: ${e}`);
    }
  }

  if (!raw) {
    log.info(`[lyrics] track=${trackId}: нет текста`);
    return null;
  }
  const line = findBestLyricsLine(searchPhrase, raw);
  log.info(`[lyrics] track=${trackId} phrase=${JSON.stringify(searchPhrase)} → ${JSON.stringify(line)}`);
  return line;
}

/** +3с «качаю», +8с «отправляю». cancel() дожидается завершения тикера — иначе
 * осиротевший тикер сработает уже ПОСЛЕ editMessageMedia и перетрёт «открыть» обратно. */
function startProgressTicker(bot: Bot, inlineMsgId: string, trackId: string): () => Promise<void> {
  let cancelled = false;
  const { sleep, wake } = createInterruptibleSleep();
  const done = (async () => {
    await sleep(3000);
    if (cancelled) return;
    await safeSetReplyMarkup(bot, inlineMsgId, progressMarkup(trackId, BTN_DOWNLOADING));
    if (cancelled) return; // отмена во время edit'а «качаю» — не входим в 8с-сон
    await sleep(8000);
    if (cancelled) return;
    await safeSetReplyMarkup(bot, inlineMsgId, progressMarkup(trackId, BTN_SENDING));
  })().catch(() => undefined);
  return async () => {
    cancelled = true;
    wake();
    await done;
  };
}

/** `npr:` после chosen: лимитер → resolveRichCard (карточка + трек параллельно). Любой
 * исход, кроме успеха/фолбэка, заканчивается кнопкой с load: — плейсхолдер не залипает. */
export async function chosenRichCardTrack(
  bot: Bot,
  container: Container,
  resultId: string,
  inlineMsgId: string,
  userId: number,
): Promise<void> {
  const payload = peekCardPending(resultId);
  if (payload === null) {
    await resolveRichCard(bot, container, resultId, inlineMsgId, async () => null); // → expired + retry
    return;
  }
  const trackId = String(payload.trackId);
  if (payload.userId !== userId) {
    // защита в глубину: стэш чужого пользователя трактуем как протухший
    log.warning(`[chosen] rich ${resultId}: стэш user=${payload.userId}, chosen user=${userId} — игнор`);
    await safeSetReplyMarkup(bot, inlineMsgId, retryMarkup(trackId));
    return;
  }
  let token: string | null;
  try {
    const [allowed, retryAfter] = container.downloadLimiter.check(userId);
    if (!allowed) {
      await safeSetReplyMarkup(bot, inlineMsgId, progressMarkup(trackId, tooOftenButton(retryAfter)));
      return;
    }
    token = await container.resolveToken(userId);
  } catch (e) {
    log.error(`[chosen] rich ${resultId}: токен/лимит: ${errText(e)}`);
    await safeSetReplyMarkup(bot, inlineMsgId, retryMarkup(trackId));
    return;
  }
  if (!token) {
    await safeSetReplyMarkup(bot, inlineMsgId, retryMarkup(trackId));
    return;
  }
  const getAudio = async (): Promise<RichAudio | null> => {
    const { cached, trackObj, yandex, unavailable } = await resolveTrack(container, token, userId, trackId);
    const settings = await container.getUserSettings(userId);
    const res = await ensureFileId(container, cached, trackObj, yandex, trackId, {
      quality: settings.track_quality as AudioQuality,
      unavailable,
    });
    if (!res.ok) {
      log.error(`[chosen] rich: скачивание не удалось track=${trackId} (${res.kind})`);
      return null;
    }
    const durationMs = trackObj?.durationMs ?? null;
    return {
      fileId: res.fileId,
      title: payload.title,
      performer: payload.artist,
      durationSec: durationMs ? durationMs / 1000 : (cached?.duration ?? null),
      degraded: res.degraded,
    };
  };
  await resolveRichCard(bot, container, resultId, inlineMsgId, getAudio);
}

export async function onChosenResult(
  ctx: { from: { id: number }; resultId: string; inlineMessageId?: string | null; query?: string | null },
  container: Container,
  bot: Bot,
): Promise<void> {
  const userId = ctx.from.id;
  const resultId = ctx.resultId;
  const inlineMsgId = ctx.inlineMessageId ?? null;
  log.debug(`[chosen] user=${userId} result=${resultId}`);

  const queryText = (ctx.query ?? "").trim();
  const effect = parseEffect(queryText);

  // эффект помним рядом с владельцем: в callback_data кнопки load: он не влезает,
  // а без него тап по «качаю...»/«загрузить снова» скачал бы оригинал вместо ncore.
  if (inlineMsgId) {
    container.inlineOwners.set(inlineMsgId, userId);
    if (effect) container.inlineEffects.set(inlineMsgId, effect.tier);
  }

  // альбом/плейлист — article со ссылкой на бота, качать на chosen нечего
  if (resultId.startsWith("album:") || resultId.startsWith("playlist:")) return;

  if (isRichResultId(resultId)) {
    if (inlineMsgId) await chosenRichCardTrack(bot, container, resultId, inlineMsgId, userId);
    return;
  }

  if (isCardResultId(resultId)) {
    if (!inlineMsgId) return;
    await renderAndSwapCard(bot, container, resultId, inlineMsgId, userId);
    return;
  }

  const isTextMedia = resultId.startsWith("tm:");
  const trackId = parseTrackResultId(resultId);
  if (trackId === null) {
    log.warning(`[chosen] невалидный result_id: ${JSON.stringify(resultId)}`);
    return;
  }
  if (!inlineMsgId) {
    log.error(`[chosen] нет inline_message_id (user=${userId} track=${trackId})`);
    return;
  }

  const token = await container.resolveToken(userId);
  if (!token) {
    await safeSetReplyMarkup(bot, inlineMsgId, progressMarkup(trackId, LOGIN_FIRST));
    return;
  }

  const cancelTicker = startProgressTicker(bot, inlineMsgId, trackId);
  // финальный edit на аудио: при сетевом сбое (исход неизвестен) повторяем его, а не ставим «загрузить снова»
  let finalEdit: { media: AudioEditMedia; markup: ReturnType<typeof trackMarkup> | undefined } | null = null;

  try {
    let searchPhrase = "";
    if (queryText.startsWith('"') || queryText.startsWith("«")) {
      searchPhrase = queryText.replace(/^["«]+/, "").trim();
    }

    const { cached, trackObj, yandex, unavailable } = await resolveTrack(container, token, userId, trackId);
    const settings = await container.getUserSettings(userId);
    const quality = settings.track_quality as AudioQuality;

    let artist = "";
    let title = "";
    if (cached && cached.is_cached) {
      artist = cached.artist ?? "";
      title = cached.title ?? "";
    } else if (trackObj !== null) {
      [artist, title] = formatTrackBasics(trackObj, "");
    }

    // при сбое Яндекса не выходим: ensureFileId ещё проверит тиры кэша (lossless/economy/эффект)
    if (trackObj === null && !(cached && cached.is_cached) && !unavailable) {
      log.error(`[chosen] трек ${trackId} не найден`);
      // если тикер уже успел написать «качаю...»/«отправляю...» — не оставляем
      // кнопку в этом состоянии навсегда
      await safeSetReplyMarkup(bot, inlineMsgId, retryMarkup(trackId));
      return;
    }

    if (!(cached && cached.is_cached) && trackObj && trackIsTooLong(trackObj)) {
      log.info(`[chosen] трек ${trackId} длинный — пропускаю`);
      await safeSetReplyMarkup(bot, inlineMsgId, progressMarkup(trackId, TOO_LONG_TEXT));
      return;
    }

    // тот же лимитер, что у /np и альбомов, но только когда реально начинается закачка:
    // готовый file_id из кэша лимит не тратит и кнопки не затирает.
    const ensureOpts = {
      quality,
      unavailable,
      tier: effect?.tier ?? null,
      onDownloadStart: downloadLimitGate(container, userId),
    };
    let lyricsQuote: string | null = null;
    let res: EnsureResult;
    if (searchPhrase) {
      const [ensure, lq] = await Promise.all([
        ensureFileId(container, cached, trackObj, yandex, trackId, ensureOpts),
        fetchLyricsForQuery(container, token, userId, trackId, searchPhrase, artist, title),
      ]);
      res = ensure;
      lyricsQuote = lq;
    } else {
      res = await ensureFileId(container, cached, trackObj, yandex, trackId, ensureOpts);
    }

    // для lossless/economy lossy-кэш не считается «уже на месте» — нужен своп на свой тир
    if (quality === "best" && !effect && cached && cached.is_cached && !isTextMedia && !lyricsQuote) {
      log.info(`[chosen] трек ${trackId} уже в кэше user=${userId}`);
      // реальное аудио уже в сообщении (не текст-плейсхолдер) — просто чиним
      // кнопку, если тикер успел подменить её на «качаю...»/«отправляю...»
      await safeSetReplyMarkup(bot, inlineMsgId, trackMarkup(trackId, true));
      return;
    }

    if (!res.ok) {
      log.error(`[chosen] скачивание не удалось track=${trackId} (${res.kind})`);
      await safeSetReplyMarkup(
        bot,
        inlineMsgId,
        res.kind === "unavailable" ? progressMarkup(trackId, YANDEX_DOWN) : retryMarkup(trackId),
      );
      return;
    }
    const { fileId, codec, bitrateKbps, degraded } = res;

    const layout = settings.track_layout;
    const { media, markup } = buildChosenEditPayload({
      trackId,
      fileId,
      codec,
      bitrateKbps,
      layout,
      lyricsQuote,
      degraded,
    });

    await cancelTicker(); // ДО edit'а: иначе «отправляю…» тикера легло бы поверх аудио

    finalEdit = { media, markup };
    await safeEditMedia(bot, { inlineMessageId: inlineMsgId }, media, markup);
    log.info(`[chosen] трек ${trackId} отправлен user=${userId}${degraded ? " (FLAC→mp3)" : ""}`);
  } catch (e) {
    if (e instanceof DownloadRateLimited) {
      await cancelTicker(); // иначе тикер перетрёт сообщение «подожди» своим «качаю...»
      await safeSetReplyMarkup(bot, inlineMsgId, progressMarkup(trackId, tooOftenButton(e.retryAfterSec)));
      return;
    }
    log.error(`[chosen] ошибка user=${userId} track=${trackId}: ${e}`);
    // без этого кнопка навсегда остаётся «качаю...»/«отправляю...» от тикера
    await cancelTicker();
    if (await reissueEdit(bot, inlineMsgId, finalEdit, e)) return;
    await safeSetReplyMarkup(bot, inlineMsgId, retryMarkup(trackId));
  } finally {
    await cancelTicker();
  }
}
