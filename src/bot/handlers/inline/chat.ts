import type { Bot } from "gramio";
import { format } from "gramio";
import { getLogger } from "../../../infra/logging.ts";
import type { CachedTrack } from "../../../storage/types.ts";
import { type YandexClient, YandexUnavailableError } from "../../../yandex/client.ts";
import { normalizeCoverUrl } from "../../../yandex/media.ts";
import { type AudioQuality, buildCardMeta, formatTrackBasics } from "../../../yandex/metadata.ts";
import type { YaTrack } from "../../../yandex/types.ts";
import { senderHandleOf } from "../../captions.ts";
import { buildCardImage, mintCardFileId } from "../../cardBuilder.ts";
import type { Container } from "../../container.ts";
import { chatRichSenders, deliverCardAndTrack } from "../../richMessage.ts";
import { say } from "../../safeApi.ts";
import {
  DELIVERY_PARTIAL,
  DELIVERY_UNKNOWN,
  DOWNLOADING_STATUS,
  ERROR_RETRY,
  ensureErrorText,
  LOGIN_FIRST,
  TRACK_UNSUPPORTED,
  tooOften,
  YANDEX_DOWN,
} from "../../texts.ts";
import type { TgUser } from "../../types.ts";
import { type EnsureResult, ensureFileId, resolveTrack } from "./ensure.ts";
import { chatAudioExtras } from "./shared.ts";

const log = getLogger("bot.inline");

/** позиция на карточке: замораживается в момент команды. */
export interface CardPosition {
  progressMs: number;
  durationMs: number;
  paused: boolean;
}

/** rich-ветка sendTrackToChat (настройка «карточка+трек» вкл.): карточка и трек одним
 * сообщением; при сбое — отдельные карточка и трек из тех же file_id (фолбэк молча). */
async function sendRichCardTrackToChat(a: {
  bot: Bot;
  chatId: number;
  userId: number;
  user: TgUser;
  container: Container;
  token: string;
  trackId: string;
  trackObj: YaTrack;
  cached: CachedTrack | null;
  yandex: YandexClient;
  card: CardPosition;
  quality: AudioQuality;
  trackLayout: string;
  statusMsgId: number | null;
}): Promise<void> {
  const { bot, chatId, userId, container, trackId, trackObj, statusMsgId } = a;
  const [artist, title] = formatTrackBasics(trackObj, "");
  let failKind: Extract<EnsureResult, { ok: false }>["kind"] | null = null;
  let obtained = false;
  const res = await deliverCardAndTrack({
    label: `chat user=${userId} track=${trackId}`,
    card: async () => {
      const settings = await container.getUserSettings(userId);
      const image = await buildCardImage({
        bot,
        container,
        userId,
        token: a.token,
        coverUrl: normalizeCoverUrl(trackObj.coverUri ?? "", "1000x1000"),
        title,
        artist,
        progressMs: a.card.progressMs,
        durationMs: a.card.durationMs || trackObj.durationMs || 0,
        paused: a.card.paused,
        // нет длительности позиции = открыто по ссылке, а не из «что играет»: без линии прогресса
        hideProgress: a.card.durationMs <= 0,
        senderHandle: senderHandleOf(a.user),
        meta: buildCardMeta(trackObj),
        settings,
      });
      return mintCardFileId(bot, container.channelId, image, `chat:${trackId}`);
    },
    track: async () => {
      const r = await ensureFileId(container, a.cached, trackObj, a.yandex, trackId, {
        quality: a.quality,
        onDownloadStart: async () => {
          if (statusMsgId === null) return;
          try {
            await bot.api.editMessageText({
              chat_id: chatId,
              message_id: statusMsgId,
              text: format`${DOWNLOADING_STATUS}`,
            } as never);
          } catch {
            /* ignore */
          }
        },
      });
      if (!r.ok) {
        failKind = r.kind;
        return null;
      }
      obtained = true;
      return {
        fileId: r.fileId,
        title,
        performer: artist,
        durationSec: trackObj.durationMs ? trackObj.durationMs / 1000 : (a.cached?.duration ?? null),
        degraded: r.degraded,
        codec: r.codec,
        bitrateKbps: r.bitrateKbps,
      };
    },
    ...chatRichSenders(bot, chatId, {
      trackId,
      trackLayout: a.trackLayout,
      botUsername: container.botUsername,
      audioExtras: (au) =>
        chatAudioExtras({
          trackId,
          fileId: au.fileId,
          codec: au.codec ?? null,
          bitrateKbps: au.bitrateKbps ?? null,
          layout: a.trackLayout,
          degraded: au.degraded,
        }),
    }),
  });
  if (res === "unknown") {
    // rich-запрос мог дойти (нет ответа API): ничего не досылаем, чтобы не продублировать
    await say(bot, chatId, statusMsgId, format`${DELIVERY_UNKNOWN}`);
    return;
  }
  if (res === "partial") {
    // карточка уже в чате — ошибка только про трек, чтобы повтор не слал карточку второй раз
    await say(bot, chatId, statusMsgId, format`${DELIVERY_PARTIAL}`);
    return;
  }
  if (res === "none" || !obtained) {
    // карточка (если вышла) уже отправлена фолбэком; статус превращаем в ошибку, как в обычном пути
    await say(bot, chatId, statusMsgId, failKind ? ensureErrorText(failKind) : format`${ERROR_RETRY}`);
    return;
  }
  void a.yandex.reportPlayback(trackObj);
  if (statusMsgId !== null) {
    try {
      await bot.api.deleteMessage({ chat_id: chatId, message_id: statusMsgId });
    } catch {
      /* ignore */
    }
  }
}

/** общий путь для deep-link и «что играет». card+user — только если вызывающий хочет
 * карточку; она рисуется при включённой настройке rich_messages. */
export async function sendTrackToChat(args: {
  bot: Bot;
  chatId: number;
  userId: number;
  container: Container;
  trackId: string;
  trackObj?: YaTrack | null;
  token?: string | null;
  statusMsgId?: number | null;
  checkLimit?: boolean;
  user?: TgUser;
  card?: CardPosition;
}): Promise<void> {
  const { bot, chatId, userId, container, trackId } = args;
  const statusMsgId = args.statusMsgId ?? null;
  let token = args.token ?? null;

  // Ynison иногда отдаёт track_id как UUID (подкасты/аудиокниги), не число — а он уходит
  // в Postgres bigint (storage/cache.ts: Number(trackId)), нечисловой даст NaN. Отсекаем явно.
  if (!/^\d+$/.test(trackId)) {
    log.warning(`[track_dm] нечисловой trackId (не catalog-трек?): ${JSON.stringify(trackId)}`);
    await say(bot, chatId, statusMsgId, format`${TRACK_UNSUPPORTED}`);
    return;
  }

  if (args.checkLimit !== false) {
    const [allowed, retryAfter] = container.downloadLimiter.check(userId);
    if (!allowed) {
      await say(bot, chatId, statusMsgId, format`${tooOften(retryAfter)}`);
      return;
    }
  }

  if (token === null) {
    token = await container.resolveToken(userId);
    if (!token) {
      await say(bot, chatId, statusMsgId, format`${LOGIN_FIRST}`);
      return;
    }
  }

  try {
    const { cached, trackObj, yandex, unavailable } = await resolveTrack(
      container,
      token,
      userId,
      trackId,
      args.trackObj ?? null,
    );
    const settings = await container.getUserSettings(userId);
    const quality = settings.track_quality as AudioQuality;

    if (args.card && args.user && trackObj && settings.rich_messages) {
      await sendRichCardTrackToChat({
        bot,
        chatId,
        userId,
        user: args.user,
        container,
        token,
        trackId,
        trackObj,
        cached,
        yandex,
        card: args.card,
        quality,
        trackLayout: settings.track_layout,
        statusMsgId,
      });
      return;
    }

    const res = await ensureFileId(container, cached, trackObj, yandex, trackId, {
      quality,
      unavailable,
      onDownloadStart: async () => {
        if (statusMsgId === null) return;
        try {
          await bot.api.editMessageText({
            chat_id: chatId,
            message_id: statusMsgId,
            text: format`${DOWNLOADING_STATUS}`,
          } as never);
        } catch {
          /* ignore */
        }
      },
    });
    if (!res.ok) {
      await say(bot, chatId, statusMsgId, ensureErrorText(res.kind));
      return;
    }

    await bot.api.sendAudio({
      chat_id: chatId,
      audio: res.fileId,
      ...chatAudioExtras({
        trackId,
        fileId: res.fileId,
        codec: res.codec,
        bitrateKbps: res.bitrateKbps,
        layout: settings.track_layout,
        degraded: res.degraded,
      }),
    });
    if (trackObj) void yandex.reportPlayback(trackObj);
    if (statusMsgId !== null) {
      try {
        await bot.api.deleteMessage({ chat_id: chatId, message_id: statusMsgId });
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    if (e instanceof YandexUnavailableError) {
      log.warning(`[track_dm] ${e.message} user=${userId} track=${trackId}`);
      await say(bot, chatId, statusMsgId, format`${YANDEX_DOWN}`);
      return;
    }
    log.error(`[track_dm] ошибка user=${userId} track=${trackId}: ${e}`);
    await say(bot, chatId, statusMsgId, format`${ERROR_RETRY}`);
  }
}
