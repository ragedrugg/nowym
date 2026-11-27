import { type FormatResult, format } from "yaebal";
import { getLogger } from "../../../infra/logging.ts";
import { buildLyricsQuote, buildTrackCaption } from "../../captions.ts";
import type { Container } from "../../container.ts";
import { trackMarkup } from "../../markup.ts";
import { type AudioExtras, errText, isApiError } from "../../richMessage.ts";
import { safeEditMedia } from "../../safeApi.ts";
import { DEGRADED_NOTE, EFFECT_SUFFIX } from "../../texts.ts";
import type { ApiBot } from "../../types.ts";

const log = getLogger("bot.inline");

/** пустой/ошибочный inline-ответ: без cache_time Telegram держит его 300 с и может отдать
 * другим юзерам с тем же запросом — «попробуй ещё раз» не сработал бы, чужое «ничего не играет» прилипло бы. */
export const EMPTY_ANSWER_PARAMS = { cache_time: 3, is_personal: true } as const;

/** лимитер скачивания сработал уже на старте закачки (см. ensureFileId.onDownloadStart). */
export class DownloadRateLimited extends Error {
  readonly retryAfterSec: number;

  constructor(retryAfterSec: number) {
    super("download rate limited");
    this.retryAfterSec = retryAfterSec;
  }
}

/** onDownloadStart-хук: кэшированное лимит не тратит, реальная закачка — тратит. */
export function downloadLimitGate(container: Container, userId: number): () => Promise<void> {
  return async () => {
    const [allowed, retryAfter] = container.downloadLimiter.check(userId);
    if (!allowed) throw new DownloadRateLimited(retryAfter);
  };
}

// ── аудио-эффекты ─────────────────────────────────────────────────────────
// `@nowymbot <префикс> <запрос>` — обычный поиск, но выбранный трек отдаётся
// с эффектом (перекодировка ffmpeg на выборе).
export interface AudioEffect {
  /** ffmpeg `-af` цепочка. asetrate спереди с `aresample=44100` — независимо от sr источника. */
  filter: string;
  /** длительность делится на этот фактор (>1 короче, <1 длиннее) — иначе плеер врёт длину. */
  speedFactor: number;
  /** добавка к title, чтоб файл не путался с оригиналом в библиотеке. */
  suffix: string;
}

export const AUDIO_EFFECTS: Record<string, AudioEffect> = {
  // asetrate поднимает и темп, и тон (~+25%, ≈ +3.86 полутона) — каноничный nightcore.
  ncore: {
    filter: "aresample=44100,asetrate=44100*1.25,aresample=44100",
    speedFactor: 1.25,
    suffix: EFFECT_SUFFIX.ncore,
  },
  // atempo меняет только темп, тон сохраняется — «честное» ускорение.
  speed: { filter: "atempo=1.2", speedFactor: 1.2, suffix: EFFECT_SUFFIX.speed },
  // asetrate вниз (питч+темп ниже) + многотактовый aecho как реверб-хвост.
  slow: {
    filter: "aresample=44100,asetrate=44100*0.9,aresample=44100,aecho=0.8:0.85:55|95:0.35|0.25",
    speedFactor: 0.9,
    suffix: EFFECT_SUFFIX.slow,
  },
};

const EFFECT_RE = new RegExp(`^(${Object.keys(AUDIO_EFFECTS).join("|")})\\s+(.+)`, "i");
export const EFFECT_BITRATE = 320;

export function parseEffect(text: string): { tier: string; effect: AudioEffect; query: string } | null {
  const m = EFFECT_RE.exec(text);
  if (m === null) return null;
  const tier = m[1]!.toLowerCase();
  return { tier, effect: AUDIO_EFFECTS[tier]!, query: m[2]!.trim() };
}

/** null, если result_id не сводится к числовому trackId. */
export function parseTrackResultId(resultId: string): string | null {
  const id = resultId.startsWith("tm:") ? resultId.slice(3) : resultId;
  return /^\d+$/.test(id) ? id : null;
}

/** InputMediaAudio (file_id) для editMessageMedia. */
export type AudioEditMedia = { type: "audio"; media: string; caption?: FormatResult };

/** InputMediaAudio для editMessageMedia + reply_markup под выбранный layout. */
export function buildChosenEditPayload(args: {
  trackId: string;
  fileId: string;
  codec: string | null;
  bitrateKbps: number | null;
  layout: string;
  lyricsQuote?: string | null;
  degraded?: boolean;
}): { media: AudioEditMedia; markup: ReturnType<typeof trackMarkup> | undefined } {
  const { trackId, fileId, codec, bitrateKbps, layout, lyricsQuote, degraded } = args;
  const prefix = buildLyricsQuote(lyricsQuote ?? null);
  const trackCaption = buildTrackCaption(trackId, codec, bitrateKbps, degraded);

  if (layout === "none") {
    const media: AudioEditMedia = { type: "audio", media: fileId };
    if (prefix) media.caption = prefix;
    return { media, markup: undefined };
  }
  if (layout === "text") {
    const caption = prefix ? format`${prefix}\n${trackCaption}` : trackCaption;
    return { media: { type: "audio", media: fileId, caption }, markup: undefined };
  }
  if (layout === "both") {
    const caption = prefix ? format`${prefix}\n${trackCaption}` : trackCaption;
    return { media: { type: "audio", media: fileId, caption }, markup: trackMarkup(trackId, true) };
  }
  // "button"
  const media: AudioEditMedia = { type: "audio", media: fileId };
  if (prefix) media.caption = prefix;
  return { media, markup: trackMarkup(trackId, true) };
}

/** caption + reply_markup для трека в чат (лс/чат) — те же, что у inline по track_layout.
 * При «кнопка»/«ничего» подписи нет — пометку о деградации качества даём отдельной подписью. */
export function chatAudioExtras(args: {
  trackId: string;
  fileId: string;
  codec: string | null;
  bitrateKbps: number | null;
  layout: string;
  degraded: boolean;
}): AudioExtras {
  const { media, markup } = buildChosenEditPayload(args);
  const caption = media.caption ?? (args.degraded ? DEGRADED_NOTE : undefined);
  return { ...(caption ? { caption } : {}), ...(markup ? { reply_markup: markup } : {}) };
}

/** editMessageMedia упал без ответа API (сеть/таймаут) — Telegram мог его применить: повторяем
 * тот же edit один раз (уже применён → «not modified» = успех). true — аудио на месте.
 * Ответ API (error_code) = edit точно не прошёл → false, вызывающий ставит «загрузить снова». */
export async function reissueEdit(
  bot: ApiBot,
  inlineMsgId: string,
  edit: { media: AudioEditMedia; markup: ReturnType<typeof trackMarkup> | undefined } | null,
  err: unknown,
): Promise<boolean> {
  if (edit === null || isApiError(err)) return false;
  try {
    await safeEditMedia(bot, { inlineMessageId: inlineMsgId }, edit.media, edit.markup);
    log.info(`[edit] повтор editMessageMedia после неясного исхода прошёл (${errText(err)})`);
    return true;
  } catch (e) {
    log.warning(`[edit] повтор editMessageMedia не прошёл: ${errText(e)}`);
    return false;
  }
}
