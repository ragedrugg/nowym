/** Адаптер Telegram Rich Messages: карточка «что играет» + трек одним сообщением.
 *
 * Модуль чистый: без БД, таймеров и импортов из handlers/**. file_id карточки и
 * трека получаем через инжектируемые колбэки, отправку делаем через переданный bot.api.
 * В rich_message кладём ТОЛЬКО file_id (gramio не умеет multipart для rich_message,
 * а Bot API запрещает аплоад при правке inline-сообщения).
 * Сбой с ответом API => один warning `[rich]` и результат "fallback": вызывающий код
 * отдаёт карточку и трек по отдельности из уже полученных file_id (без повторного
 * рендера/скачивания). Наружу ничего не бросается. */
import {
  type Bot,
  type FormattableString,
  type InlineKeyboard,
  TelegramError,
  type TelegramInputRichMessage,
} from "gramio";
import { floodRetry } from "../infra/floodRetry.ts";
import { getLogger } from "../infra/logging.ts";
import { nowPlayingMarkup, trackMarkup } from "./markup.ts";
import { DEGRADED_NOTE } from "./texts.ts";

const log = getLogger("bot.rich");

export { DEGRADED_NOTE } from "./texts.ts";

/** лимит Telegram на title/performer аудио (символов). */
const MAX_AUDIO_TEXT = 256;

export interface RichAudio {
  fileId: string;
  title: string;
  performer: string;
  durationSec: number | null;
  /** запрошено «превосходное», но отдаём оптимальное. */
  degraded: boolean;
  /** для подписи качества в фолбэк-аудио (track_layout «текст»/«всё»). */
  codec?: string | null;
  bitrateKbps?: number | null;
}

/** file_id карточки + освобождение служебного сообщения в канале (best-effort). */
export interface MintedCard {
  fileId: string;
  release(): void;
}

export type RichTarget =
  | { kind: "chat"; chatId: number | string }
  | { kind: "chatMessage"; chatId: number | string; messageId: number }
  | { kind: "inline"; inlineMessageId: string };

/** "unknown": rich-запрос оборвался без ответа Telegram (сеть/таймаут) — сообщение могло
 * дойти, поэтому фолбэк НЕ запускаем (иначе дубль); вызывающий ничего не досылает. */
export type DeliverResult = "rich" | "fallback" | "none" | "unknown" | "partial";

/** фолбэк уже отправил карточку, а трек не ушёл: повтор целиком продублировал бы карточку. */
export class PartialDeliveryError extends Error {
  constructor(cause: unknown) {
    super(`карточка отправлена, трек нет: ${errText(cause)}`);
    this.name = "PartialDeliveryError";
  }
}

/** caption/reply_markup отдельного аудио в чат (sendAudio) — по track_layout. */
export interface AudioExtras {
  caption?: FormattableString | string;
  reply_markup?: InlineKeyboard;
}

export interface FallbackInput {
  cardFileId: string | null;
  audio: RichAudio | null;
}

type RichCaptionText = NonNullable<
  Extract<NonNullable<TelegramInputRichMessage["blocks"]>[number], { type: "audio" }>["caption"]
>["text"];

/** Типы @gramio/types описывают RichText только как объекты (без обычной строки),
 * хотя Bot API принимает строку — единственный каст ради подписи блока. */
const richText = (s: string): RichCaptionText => s as unknown as RichCaptionText;

/** photo-блок (карточка) + audio-блок (трек): форма, проверенная вживую. */
export function buildRichCardTrack(cardFileId: string, audio: RichAudio): TelegramInputRichMessage {
  const performer = audio.performer.trim().slice(0, MAX_AUDIO_TEXT);
  const duration = audio.durationSec !== null && Number.isFinite(audio.durationSec) ? Math.round(audio.durationSec) : 0;
  return {
    blocks: [
      { type: "photo", photo: { type: "photo", media: cardFileId } },
      {
        type: "audio",
        audio: {
          type: "audio",
          media: audio.fileId,
          title: audio.title.slice(0, MAX_AUDIO_TEXT),
          ...(performer ? { performer } : {}),
          ...(duration > 0 ? { duration } : {}),
        },
        ...(audio.degraded ? { caption: { text: richText(DEGRADED_NOTE) } } : {}),
      },
    ],
  } satisfies TelegramInputRichMessage;
}

/** клавиатура под rich-сообщением: ♥ + открыть; при track_layout=none — без неё. */
export function richTrackMarkup(trackId: string, trackLayout: string): InlineKeyboard | undefined {
  return trackLayout === "none" ? undefined : trackMarkup(trackId, true);
}

const NOT_MODIFIED = /message is not modified/i;
const BOT_TOKEN = /bot\d+:[\w-]+/g;

export function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(BOT_TOKEN, "bot<token>").slice(0, 300);
}

/** Определённый ответ Bot API (есть error_code): запрос точно не выполнен, фолбэк безопасен.
 * Иначе (сеть/таймаут) исход неизвестен — Telegram мог применить запрос. */
export function isApiError(e: unknown): boolean {
  if (e instanceof TelegramError) return true;
  const x = e as { name?: unknown; code?: unknown } | null;
  return x?.name === "TelegramError" && typeof x.code === "number";
}

/** Отправка rich_message в цель; бросает при сбое, «not modified» = успех. */
export function makeRichSend(
  bot: Bot,
  target: RichTarget,
  reply_markup?: InlineKeyboard,
): (rich: TelegramInputRichMessage) => Promise<void> {
  return async (rich_message) => {
    try {
      if (target.kind === "chat") {
        await bot.api.sendRichMessage({ chat_id: target.chatId, rich_message, reply_markup });
      } else if (target.kind === "chatMessage") {
        await bot.api.editMessageText({
          chat_id: target.chatId,
          message_id: target.messageId,
          rich_message,
          reply_markup,
        });
      } else {
        await bot.api.editMessageText({
          inline_message_id: target.inlineMessageId,
          rich_message,
          reply_markup,
        });
      }
    } catch (e) {
      if (NOT_MODIFIED.test(errText(e))) return;
      throw e;
    }
  };
}

/** Единая точка для всех сценариев: получает file_id карточки и трека параллельно,
 * шлёт одним rich-сообщением, а при любом сбое зовёт fallback с уже имеющимися file_id.
 * Сеть/таймаут (нет ответа API) => "unknown" без фолбэка. Не бросает: ошибка самого fallback логируется и даёт "none" (вызывающий покажет свою ошибку). */
export async function deliverCardAndTrack(o: {
  /** для логов, напр. "np user=1 track=2" (без токенов). */
  label: string;
  card: () => Promise<MintedCard | null>;
  track: () => Promise<RichAudio | null>;
  /** бросает при сбое. */
  sendRich: (rich: TelegramInputRichMessage) => Promise<void>;
  fallback: (got: FallbackInput) => Promise<void>;
}): Promise<DeliverResult> {
  const [cardR, trackR] = await Promise.allSettled([o.card(), o.track()]);
  const card = cardR.status === "fulfilled" ? cardR.value : null;
  const audio = trackR.status === "fulfilled" ? trackR.value : null;
  if (cardR.status === "rejected") log.warning(`[rich] ${o.label}: карточка: ${errText(cardR.reason)}`);
  if (trackR.status === "rejected") log.warning(`[rich] ${o.label}: трек: ${errText(trackR.reason)}`);
  try {
    if (!card && !audio) return "none";
    if (card && audio) {
      try {
        await floodRetry(() => o.sendRich(buildRichCardTrack(card.fileId, audio)), {
          attempts: 3,
          graceMs: 500,
          onWait: (ra, n) => log.warning(`[rich] ${o.label}: 429, ждём ${ra}s (попытка ${n}/3)`),
        });
        log.info(`[rich] ${o.label} ok`);
        return "rich";
      } catch (e) {
        if (!isApiError(e)) {
          log.warning(`[rich] ${o.label}: ${errText(e)} → исход неизвестен, без фолбэка`);
          return "unknown";
        }
        log.warning(`[rich] ${o.label}: ${errText(e)} → фолбэк`);
      }
    }
    try {
      await o.fallback({ cardFileId: card?.fileId ?? null, audio });
      return "fallback";
    } catch (e) {
      log.warning(`[rich] ${o.label}: фолбэк упал: ${errText(e)}`);
      return e instanceof PartialDeliveryError ? "partial" : "none";
    }
  } finally {
    // канал-копию карточки удаляем только после того, как file_id использован
    try {
      card?.release();
    } catch {
      /* best-effort */
    }
  }
}

/** sendRich/fallback для обычного чата: rich-сообщение или отдельные карточка + трек
 * (ровно как без rich: sendPhoto с nowPlayingMarkup, затем sendAudio). */
export function chatRichSenders(
  bot: Bot,
  chatId: number | string,
  o: {
    trackId: string;
    trackLayout: string;
    botUsername: string | null;
    /** caption/reply_markup фолбэк-аудио по track_layout; без него — только пометка о деградации. */
    audioExtras?: (audio: RichAudio) => AudioExtras;
  },
): {
  sendRich: (rich: TelegramInputRichMessage) => Promise<void>;
  fallback: (got: FallbackInput) => Promise<void>;
} {
  return {
    sendRich: makeRichSend(bot, { kind: "chat", chatId }, richTrackMarkup(o.trackId, o.trackLayout)),
    fallback: async ({ cardFileId, audio }) => {
      if (cardFileId) {
        await bot.api.sendPhoto({
          chat_id: chatId,
          photo: cardFileId,
          reply_markup: nowPlayingMarkup(o.trackId, o.botUsername),
        });
      }
      if (audio) {
        try {
          const extras: AudioExtras = o.audioExtras
            ? o.audioExtras(audio)
            : audio.degraded
              ? { caption: DEGRADED_NOTE }
              : {};
          await bot.api.sendAudio({ chat_id: chatId, audio: audio.fileId, ...extras });
        } catch (e) {
          if (cardFileId) throw new PartialDeliveryError(e);
          throw e;
        }
      }
    },
  };
}
