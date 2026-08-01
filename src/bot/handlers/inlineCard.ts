import { type FormattableString, format, InlineQueryResult, InputMessageContent, link, MediaUpload } from "gramio";
import type { Bot } from "gramio";
import type { Container } from "../container.ts";
import { nowPlayingMarkup, progressMarkup } from "../markup.ts";
import { getLogger } from "../../infra/logging.ts";
import { LRUMap } from "../../infra/lruMap.ts";
import { normalizeCoverUrl } from "../../yandex/media.ts";
import { bestLyricsLineIndex, buildCardMeta, formatTrackBasics, splitLyricsLines } from "../../yandex/metadata.ts";
import { buildCardImage } from "../cardBuilder.ts";
import { senderHandleOf } from "../captions.ts";
import { floodRetry } from "../../infra/floodRetry.ts";
import type { LyricsBlock } from "../../services/card.ts";
import { trackUrl } from "../../yandex/urls.ts";
import type { CardMeta, YaTrack } from "../../yandex/types.ts";

const log = getLogger("bot.inline_card");

interface CardPayload {
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
  /** задан → лирик-карточка: на рендере тянем текст и подсвечиваем строку фразы. */
  lyricPhrase?: string;
}

// стэш: inline_query кладёт payload → chosen_inline_result достаёт (FIFO + LRU-cap).
const CARD_PENDING_MAX = 200;
const cardPending = new LRUMap<string, CardPayload>(CARD_PENDING_MAX);

function stashCardPending(resultId: string, payload: CardPayload): void {
  cardPending.set(resultId, payload);
}

// peek, НЕ take: Telegram кэширует инлайн-выдачу у клиента на cache_time, поэтому
// одну и ту же карточку можно отправить повторно — одноразовый стэш давал пустой рендер.
function peekCardPending(resultId: string): CardPayload | null {
  return cardPending.get(resultId) ?? null;
}

export function isCardResultId(resultId: string): boolean {
  return resultId.startsWith("npc:") || resultId.startsWith("lyc:");
}

/** artist/title/обложки(две размерности)/handle — общий набор для обоих билдеров карточек. */
export function trackCardBasics(
  track: YaTrack,
  user: { username?: string | null; firstName?: string | null },
): { artist: string; title: string; coverUrl: string; thumb: string; senderHandle: string } {
  const [artist, title] = formatTrackBasics(track, "");
  return {
    artist, title,
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
  });

  // reply_markup обязателен даже для text/none — иначе tg не отдаёт inline_message_id
  const initialMarkup =
    cardLayout === "text" || cardLayout === "none"
      ? progressMarkup(String(track.id), "готовлю...")
      : nowPlayingMarkup(track.id!, container.botUsername);

  return buildCardArticle({
    resultId, label: "оформить карточкой", placeholderText: "готовлю карточку...",
    artist, title, thumb, markup: initialMarkup,
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
    resultId, label: "🪪 карточка с текстом", placeholderText: "готовлю карточку с текстом...",
    artist, title, thumb, markup: nowPlayingMarkup(track.id!, container.botUsername),
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
 * Genius уже искал эту песню на inline-запросе, так что скрейп обычно из кэша. */
async function fetchLyricsWithFallback(
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
      const raw = await container.genius.lyricsForPhrase(phrase);
      if (raw) return raw;
    } catch (e) {
      log.warning(`[chosen] genius-лирика track=${trackId}: ${e}`);
    }
  }
  if (token) {
    try {
      const yandex = await container.getYandexService(token, userId);
      const raw = await yandex.getTrackLyrics(trackId);
      if (raw) {
        log.info(`[chosen] лирика для карточки взята из Яндекса track=${trackId}`);
        return raw;
      }
    } catch (e) {
      log.warning(`[chosen] яндекс-лирика track=${trackId}: ${e}`);
    }
  }
  return null;
}

/** ленивый рендер, подмена placeholder-текста на фото через editMessageMedia. */
export async function renderAndSwapCard(
  bot: Bot,
  container: Container,
  resultId: string,
  inlineMsgId: string,
): Promise<void> {
  const payload = peekCardPending(resultId);
  if (payload === null) {
    log.warning(`[chosen] нет pending payload для карточки ${resultId}`);
    return;
  }

  try {
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
      senderHandle: payload.senderHandle,
      meta: payload.meta,
      settings,
      lyrics,
    });

    // Telegram не даёт залить буфер напрямую в editMessageMedia по inline_message_id
    // (только file_id/URL) — минтим file_id аплоадом в служебный чат, потом удаляем.
    // Под бёрстом аплоад ловит 429 — ретраим по retry_after.
    const msg = await floodRetry(
      () =>
        bot.api.sendPhoto({
          chat_id: container.channelId,
          photo: MediaUpload.buffer(image, "now_playing.jpg"),
        }),
      {
        attempts: 3,
        graceMs: 500,
        onWait: (ra, n) => log.warning(`[chosen] карточка ${resultId}: 429, ждём ${ra}s (попытка ${n}/3)`),
      },
    );
    const fileId = msg.photo?.at(-1)?.file_id ?? "";

    try {
      const { media, markup } = cardMediaAndMarkup({
        fileId,
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
      // file_id ссылается на файл в хранилище tg, не на сообщение — валиден и после удаления.
      void bot.api
        .deleteMessage({ chat_id: container.channelId, message_id: msg.message_id })
        .catch(() => undefined);
    }
  } catch (e) {
    log.error(`[chosen] карточка ${resultId}: ${e}`);
  }
}
