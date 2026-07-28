/** Реализация TelegramSender (services/cache.ts) поверх GramIO bot.api.
 *
 * Канало-привязанная отправка вынесена в отдельный адаптер; 429-флуд берёт
 * на себя локальный floodRetry (см. ниже). */
import type { Bot } from "gramio";
import { MediaUpload } from "gramio";
import { getLogger } from "../infra/logging.ts";
import { floodRetry } from "../infra/floodRetry.ts";
import type { SendAudioOpts, SentAudio, TelegramSender } from "../services/cache.ts";

const log = getLogger("bot.telegram_sender");

const FLOOD_ATTEMPTS = 3;

// 429-флуд берёт на себя общий floodRetry (infra/floodRetry.ts). build ОБЯЗАН
// пересоздавать payload на каждой попытке: MediaUpload одноразов.
const flood = <T>(build: () => Promise<T>): Promise<T> =>
  floodRetry(build, {
    attempts: FLOOD_ATTEMPTS,
    onWait: (ra, attempt) =>
      log.warning(`flood 429: ждём ${ra}s (попытка ${attempt}/${FLOOD_ATTEMPTS})`),
  });

export class ChannelSender implements TelegramSender {
  constructor(
    private bot: Bot,
    private channelId: string,
  ) {}

  async sendAudioToChannel(audio: Buffer, opts: SendAudioOpts): Promise<SentAudio> {
    const msg = await flood(() =>
      this.bot.api.sendAudio({
        chat_id: this.channelId,
        audio: MediaUpload.buffer(audio, opts.filename),
        title: opts.title,
        performer: opts.performer,
        duration: opts.duration,
        ...(opts.thumbnail ? { thumbnail: MediaUpload.buffer(opts.thumbnail, "cover.jpg") } : {}),
      }),
    );
    // FLAC официально не audio — telegram может вернуть его как document.
    // Берём file_id из любого подходящего поля, чтобы не потерять загрузку.
    const fileId = msg.audio?.file_id ?? msg.document?.file_id ?? "";
    if (!msg.audio && msg.document) log.warning(`канал вернул document, не audio (${opts.filename})`);
    return { fileId, messageId: msg.message_id };
  }

  async deleteChannelMessage(messageId: number): Promise<void> {
    try {
      await this.bot.api.deleteMessage({ chat_id: this.channelId, message_id: messageId });
    } catch (e) {
      log.debug(`не вышло удалить msg=${messageId} из канала: ${e}`);
    }
  }
}
