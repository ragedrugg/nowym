import type { Bot } from "gramio";
import { type FormattableString, format, InlineQueryResult, InputMessageContent, link } from "gramio";
import { withTimeout } from "../../infra/async.ts";
import { getLogger } from "../../infra/logging.ts";
import { LRUMap } from "../../infra/lruMap.ts";
import type { LyricsBlock } from "../../services/card.ts";
import { normalizeCoverUrl } from "../../yandex/media.ts";
import { bestLyricsLineIndex, buildCardMeta, formatTrackBasics, splitLyricsLines } from "../../yandex/metadata.ts";
import type { CardMeta, YaTrack } from "../../yandex/types.ts";
import { trackUrl } from "../../yandex/urls.ts";
import { senderHandleOf } from "../captions.ts";
import { buildCardImage, mintCardFileId } from "../cardBuilder.ts";
import type { Container } from "../container.ts";
import { nowPlayingMarkup, progressMarkup, retryMarkup, trackMarkup } from "../markup.ts";
import {
  DEGRADED_NOTE,
  type DeliverResult,
  deliverCardAndTrack,
  errText,
  type FallbackInput,
  type MintedCard,
  makeRichSend,
  type RichAudio,
  richTrackMarkup,
} from "../richMessage.ts";

const log = getLogger("bot.inline_card");

export interface CardPayload {
  trackId: number | string;
  title: string;
  artist: string;
  coverUrl: string;
  progressMs: number;
  durationMs: number;
  paused: boolean;
  userId: number;
  senderHandle: string;
  meta: CardMeta;
  cardLayout: string;
  /** карточка по ссылке на трек: без линии прогресса и таймингов. */
  hideProgress?: boolean;
  /** задан → лирик-карточка: на рендере тянем текст и подсвечиваем строку фразы. */
  lyricPhrase?: string;
}

// стэш: inline_query кладёт payload → chosen_inline_result достаёт (FIFO + LRU-cap).
// ёмкость с запасом под время жизни выдачи: клиент держит её минуты, chosen может прийти поздно.
const CARD_PENDING_MAX = 2000;
const cardPending = new LRUMap<string, CardPayload>(CARD_PENDING_MAX);

function stashCardPending(resultId: string, payload: CardPayload): void {
  cardPending.set(resultId, payload);
}

// peek, НЕ take: Telegram кэширует инлайн-выдачу у клиента на cache_time, поэтому
// одну и ту же карточку можно отправить повторно — одноразовый стэш давал пустой рендер.
export function peekCardPending(resultId: string): CardPayload | null {
  return cardPending.get(resultId) ?? null;
}

export function isCardResultId(resultId: string): boolean {
  return resultId.startsWith("npc:") || resultId.startsWith("lyc:");
}

/** id плейсхолдера «карточка+трек»: npr:<user>:<track>:<sec>. */
export function isRichResultId(resultId: string): boolean {
  return resultId.startsWith("npr:");
}

/** трек-id может содержать «:» (альбомный `123:456`) — берём жадно между user и sec. */
export function parseRichResultId(resultId: string): { userId: number; trackId: string; sec: number } | null {
  const m = /^npr:(\d+):(.+):(\d+)$/.exec(resultId);
  if (!m) return null;
  return { userId: Number(m[1]), trackId: m[2]!, sec: Number(m[3]) };
}

/** artist/title/обложки(две размерности)/handle — общий набор для обоих билдеров карточек. */
export function trackCardBasics(
  track: YaTrack,
  user: { username?: string | null; firstName?: string | null },
): { artist: string; title: string; coverUrl: string; thumb: string; senderHandle: string } {
  const [artist, title] = formatTrackBasics(track, "");
  return {
    artist,
    title,
    coverUrl: normalizeCoverUrl(track.coverUri ?? "", "1000x1000"),
    thumb: normalizeCoverUrl(track.coverUri ?? "", "100x100"),
    senderHandle: senderHandleOf(user),
  };
}

/** лёгкий Article-обёртка для лениво рендерящейся карточки: placeholder-текст,
 * заменяется на фото в renderAndSwapCard после выбора результата. */
function buildCardArticle(args: {
  resultId: string;
  label: string;
  placeholderText: string;
  artist: string;
  title: string;
  thumb: string;
  markup: ReturnType<typeof nowPlayingMarkup> | ReturnType<typeof progressMarkup>;
}): ReturnType<typeof InlineQueryResult.article> {
  return InlineQueryResult.article(
    args.resultId,
    args.label,
    InputMessageContent.text(args.placeholderText, { link_preview_options: { is_disabled: true } }),
    {
      description: `${args.artist} — ${args.title}`,
      ...(args.thumb ? { thumbnail_url: args.thumb } : {}),
      reply_markup: args.markup,
    },
  );
}

/** лёгкий Article + стэш метаданных. без сетевых вызовов. */
export function buildNowPlayingCardResult(
  container: Container,
  track: YaTrack,
  current: { progress_ms?: number; duration_ms?: number; paused?: boolean },
  user: { id: number; username?: string | null; firstName?: string | null },
  cardLayout = "button",
  hideProgress = false,
): ReturnType<typeof InlineQueryResult.article> | null {
  const { artist, title, coverUrl, thumb, senderHandle } = trackCardBasics(track, user);
  const progressMs = current.progress_ms ?? 0;

  // user.id в id обязателен — иначе два юзера с одинаковым результатом (тот же
  // трек+секунда) делят один слот cardPending и рендер может уйти под чужим userId.
  const resultId = `npc:${user.id}:${track.id}:${Math.floor(progressMs / 1000)}`;
  stashCardPending(resultId, {
    trackId: track.id!,
    title,
    artist,
    coverUrl,
    progressMs,
    durationMs: current.duration_ms ?? 0,
    paused: Boolean(current.paused),
    userId: user.id,
    senderHandle,
    meta: buildCardMeta(track),
    cardLayout,
    hideProgress,
  });

  // reply_markup обязателен даже для text/none — иначе tg не отдаёт inline_message_id
  const initialMarkup =
    cardLayout === "text" || cardLayout === "none"
      ? progressMarkup(String(track.id), "готовлю...")
      : nowPlayingMarkup(track.id!, container.botUsername);

  return buildCardArticle({
    resultId,
    label: "оформить карточкой",
    placeholderText: "готовлю карточку...",
    artist,
    title,
    thumb,
    markup: initialMarkup,
  });
}

/** Плейсхолдер «карточка + трек» (первый вариант при включённом rich_messages).
 * Позиция замораживается здесь, на inline_query; рендер и трек — после chosen
 * (resolveRichCard). Без сетевых вызовов. */
export function buildRichNowPlayingResult(
  container: Container,
  track: YaTrack,
  current: { progress_ms?: number; duration_ms?: number; paused?: boolean },
  user: { id: number; username?: string | null; firstName?: string | null },
  hideProgress = false,
): ReturnType<typeof InlineQueryResult.article> | null {
  const { artist, title, coverUrl, thumb, senderHandle } = trackCardBasics(track, user);
  const progressMs = current.progress_ms ?? 0;
  const resultId = `npr:${user.id}:${track.id}:${Math.floor(progressMs / 1000)}`;
  stashCardPending(resultId, {
    trackId: track.id!,
    title,
    artist,
    coverUrl,
    progressMs,
    durationMs: current.duration_ms ?? 0,
    paused: Boolean(current.paused),
    userId: user.id,
    senderHandle,
    meta: buildCardMeta(track),
    cardLayout: "button",
    hideProgress,
  });
  return buildCardArticle({
    resultId,
    label: "карточка + трек",
    placeholderText: "готовлю карточку и трек...",
    artist,
    title,
    thumb,
    // url-кнопки: reply_markup обязателен, иначе tg не отдаёт inline_message_id
    markup: nowPlayingMarkup(track.id!, container.botUsername),
  });
}

/** лёгкий Article «карточка с текстом» для трека, найденного по строке лирики.
 * Текст тянем лениво на chosen (как обложку) — здесь только стэшим фразу. */
export function buildLyricsCardResult(
  container: Container,
  track: YaTrack,
  lyricPhrase: string,
  user: { id: number; username?: string | null; firstName?: string | null },
): ReturnType<typeof InlineQueryResult.article> | null {
  const { artist, title, coverUrl, thumb, senderHandle } = trackCardBasics(track, user);

  // user.id в id обязателен — та же причина, что и у npc: выше.
  const resultId = `lyc:${user.id}:${track.id}:${Math.abs(hashPhrase(lyricPhrase))}`;
  stashCardPending(resultId, {
    trackId: track.id!,
    title,
    artist,
    coverUrl,
    progressMs: 0,
    durationMs: track.durationMs ?? 0,
    paused: false,
    userId: user.id,
    senderHandle,
    meta: buildCardMeta(track),
    cardLayout: "button",
    lyricPhrase,
  });

  return buildCardArticle({
    resultId,
    label: "🪪 карточка с текстом",
    placeholderText: "готовлю карточку с текстом...",
    artist,
    title,
    thumb,
    markup: nowPlayingMarkup(track.id!, container.botUsername),
  });
}

/** короткий детерминированный хэш фразы — чтобы result_id различался по цитате. */
export function hashPhrase(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

export function cardCaption(trackId: number | string, artist: string, title: string): FormattableString {
  const a = (artist || "").trim();
  const t = (title || "").trim();
  const head = a ? `🎵 ${a} — ${t}` : `🎵 ${t}`;
  return format`${head}, ${link("в плеере", trackUrl(trackId))}`;
}

export function cardMediaAndMarkup(args: {
  fileId: string;
  trackId: number | string;
  artist: string;
  title: string;
  cardLayout: string;
  botUsername: string | null;
}): { media: Record<string, unknown>; markup: ReturnType<typeof nowPlayingMarkup> | undefined } {
  const { fileId, trackId, artist, title, cardLayout, botUsername } = args;
  if (cardLayout === "none") return { media: { type: "photo", media: fileId }, markup: undefined };
  if (cardLayout === "text") {
    return { media: { type: "photo", media: fileId, caption: cardCaption(trackId, artist, title) }, markup: undefined };
  }
  if (cardLayout === "both") {
    return {
      media: { type: "photo", media: fileId, caption: cardCaption(trackId, artist, title) },
      markup: nowPlayingMarkup(trackId, botUsername),
    };
  }
  return { media: { type: "photo", media: fileId }, markup: nowPlayingMarkup(trackId, botUsername) };
}

/** текст трека для лирик-карточки: Genius по фразе → (если пусто) Яндекс.
 * Genius уже искал эту песню на inline-запросе, так что скрейп обычно из кэша.
 * Таймауты те же, что у fetchLyricsForQuery (inline.ts): зависший источник
 * не должен держать плейсхолдер карточки бесконечно. */
export async function fetchLyricsWithFallback(
  container: Container,
  token: string | null,
  userId: number,
  trackId: number | string,
  phrase: string,
): Promise<string | null> {
  // Genius приоритетнее: трек найден по этой же фразе через него, текст совпадает
  // с цитатой; у Яндекса покрытие дырявое — он фолбэк.
  if (container.genius) {
    try {
      const raw = await withTimeout(container.genius.lyricsForPhrase(phrase), 8000);
      if (raw) return raw;
    } catch (e) {
      log.warning(`[chosen] genius-лирика track=${trackId}: ${errText(e)}`);
    }
  }
  if (token) {
    try {
      const yandex = await container.getYandexService(token, userId);
      const raw = await withTimeout(yandex.getTrackLyrics(trackId), 6000);
      if (raw) {
        log.info(`[chosen] лирика для карточки взята из Яндекса track=${trackId}`);
        return raw;
      }
    } catch (e) {
      log.warning(`[chosen] яндекс-лирика track=${trackId}: ${errText(e)}`);
    }
  }
  return null;
}

/** payload из стэша → JPEG (worker-пул) → file_id в служебном канале. */
export async function renderPendingCard(
  bot: Bot,
  container: Container,
  payload: CardPayload,
  tag: string,
): Promise<MintedCard> {
  const [settings, token] = await Promise.all([
    container.getUserSettings(payload.userId),
    container.resolveToken(payload.userId),
  ]);

  // источник текста: сначала Genius (трек и так нашёлся через него), потом Яндекс —
  // у Яндекса покрытие дырявое, андеграунд/рэп часто без текста.
  let lyrics: LyricsBlock | null = null;
  if (payload.lyricPhrase) {
    const raw = await fetchLyricsWithFallback(container, token, payload.userId, payload.trackId, payload.lyricPhrase);
    if (raw) {
      const lines = splitLyricsLines(raw);
      if (lines.length > 0) {
        lyrics = { lines, activeIndex: bestLyricsLineIndex(payload.lyricPhrase, lines) };
      }
    }
  }

  const image = await buildCardImage({
    bot,
    container,
    userId: payload.userId,
    token,
    coverUrl: payload.coverUrl,
    title: payload.title,
    artist: payload.artist,
    progressMs: payload.progressMs,
    durationMs: payload.durationMs,
    paused: payload.paused,
    hideProgress: payload.hideProgress ?? false,
    senderHandle: payload.senderHandle,
    meta: payload.meta,
    settings,
    lyrics,
  });
  return mintCardFileId(bot, container.channelId, image, tag);
}

/** ленивый рендер, подмена placeholder-текста на фото через editMessageMedia. */
export async function renderAndSwapCard(
  bot: Bot,
  container: Container,
  resultId: string,
  inlineMsgId: string,
  /** кто выбрал результат; задан → сверяем со стэшем (как в chosenRichCardTrack). */
  userId?: number,
): Promise<void> {
  const payload = peekCardPending(resultId);
  const setRetry = async (trackId: string | number): Promise<void> => {
    try {
      await bot.api.editMessageReplyMarkup({ inline_message_id: inlineMsgId, reply_markup: retryMarkup(trackId) });
    } catch (e) {
      log.warning(`[chosen] ${resultId}: retry-разметка не встала: ${errText(e)}`);
    }
  };
  if (payload === null) {
    log.warning(`[chosen] нет pending payload для карточки ${resultId}`);
    // плейсхолдер «готовлю карточку...» иначе висит вечно — даём «загрузить снова» по trackId из id
    const m = /^(?:npc|lyc):\d+:(\d+):/.exec(resultId);
    if (m) await setRetry(m[1]!);
    return;
  }
  if (userId !== undefined && payload.userId !== userId) {
    log.warning(`[chosen] карточка ${resultId}: стэш user=${payload.userId}, chosen user=${userId} — игнор`);
    await setRetry(payload.trackId);
    return;
  }

  try {
    const card = await renderPendingCard(bot, container, payload, resultId);
    try {
      const { media, markup } = cardMediaAndMarkup({
        fileId: card.fileId,
        trackId: payload.trackId,
        artist: payload.artist,
        title: payload.title,
        cardLayout: payload.cardLayout || "button",
        botUsername: container.botUsername,
      });
      await bot.api.editMessageMedia({
        inline_message_id: inlineMsgId,
        media: media as never,
        ...(markup ? { reply_markup: markup } : {}),
      });
      log.info(`[chosen] карточка ${resultId} отправлена user=${payload.userId}`);
    } finally {
      // finally, а не после await — иначе упавший editMessageMedia (протухший
      // inline_message_id, 429 сверх ретраев) оставлял бы фото в канале навсегда.
      card.release();
    }
  } catch (e) {
    log.error(`[chosen] карточка ${resultId}: ${errText(e)}`);
  }
}

/** sendRich/fallback для inline-сообщения. Фолбэк: фото карточки (кнопка «слушать в лс»
 * ведёт к треку), иначе аудио — в одном inline-сообщении может быть только одно медиа. */
export function inlineRichSenders(
  bot: Bot,
  inlineMessageId: string,
  o: {
    trackId: string | number;
    trackLayout: string;
    cardLayout: string;
    botUsername: string | null;
    artist?: string;
    title?: string;
  },
): {
  sendRich: ReturnType<typeof makeRichSend>;
  fallback: (got: FallbackInput) => Promise<void>;
} {
  return {
    sendRich: makeRichSend(bot, { kind: "inline", inlineMessageId }, richTrackMarkup(String(o.trackId), o.trackLayout)),
    fallback: async ({ cardFileId, audio }) => {
      if (cardFileId) {
        const { media, markup } = cardMediaAndMarkup({
          fileId: cardFileId,
          trackId: o.trackId,
          artist: o.artist ?? "",
          title: o.title ?? "",
          cardLayout: o.cardLayout || "button",
          botUsername: o.botUsername,
        });
        await bot.api.editMessageMedia({
          inline_message_id: inlineMessageId,
          media: media as never,
          ...(markup ? { reply_markup: markup } : {}),
        });
      } else if (audio) {
        await bot.api.editMessageMedia({
          inline_message_id: inlineMessageId,
          media: {
            type: "audio",
            media: audio.fileId,
            ...(audio.degraded ? { caption: DEGRADED_NOTE } : {}),
          } as never,
          reply_markup: trackMarkup(o.trackId, true),
        });
      }
    },
  };
}

/** Разрешение `npr:` после chosen_inline_result: карточка (пул → канал) и трек
 * (`getAudio` задаёт вызывающий: лимитер/ensureFileId) параллельно → rich_message в
 * inline-сообщение; сбой → фолбэк из тех же file_id. "expired" (стэш вытеснен) и "none"
 * ставят кнопку «загрузить снова» (load:<track>) вместо вечного плейсхолдера. Не бросает. */
export async function resolveRichCard(
  bot: Bot,
  container: Container,
  resultId: string,
  inlineMsgId: string,
  getAudio: (payload: CardPayload) => Promise<RichAudio | null>,
): Promise<DeliverResult | "expired"> {
  const payload = peekCardPending(resultId);
  const setRetry = async (trackId: string | number): Promise<void> => {
    try {
      await bot.api.editMessageReplyMarkup({ inline_message_id: inlineMsgId, reply_markup: retryMarkup(trackId) });
    } catch (e) {
      log.warning(`[rich] ${resultId}: retry-разметка не встала: ${errText(e)}`);
    }
  };
  if (payload === null) {
    log.warning(`[chosen] нет pending payload для rich-карточки ${resultId}`);
    const parsed = parseRichResultId(resultId);
    if (parsed) await setRetry(parsed.trackId);
    return "expired";
  }
  try {
    const settings = await container.getUserSettings(payload.userId);
    const res = await deliverCardAndTrack({
      label: `inline user=${payload.userId} track=${payload.trackId}`,
      card: () => renderPendingCard(bot, container, payload, resultId),
      track: () => getAudio(payload),
      ...inlineRichSenders(bot, inlineMsgId, {
        trackId: payload.trackId,
        trackLayout: settings.track_layout,
        cardLayout: payload.cardLayout,
        botUsername: container.botUsername,
        artist: payload.artist,
        title: payload.title,
      }),
    });
    if (res === "none") await setRetry(payload.trackId);
    return res;
  } catch (e) {
    log.error(`[chosen] rich ${resultId}: ${errText(e)}`);
    await setRetry(payload.trackId);
    return "none";
  }
}
