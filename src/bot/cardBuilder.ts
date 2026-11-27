/** Сборка карточки «сейчас играет»: параллельно тянет обложку, аватар и (если
 * нужно) wave-цвет, затем рендерит. Общая точка входа для /np и inline-карточки.
 * `enrichCardMetaLiked` не вызывается — лайк живёт кнопкой на треке, не на карточке. */
import { media } from "yaebal";
import { floodRetry } from "../infra/floodRetry.ts";
import { getLogger } from "../infra/logging.ts";
import type { LyricsBlock } from "../services/card/index.ts";
import type { UserSettings } from "../storage/settings.ts";
import { fetchCover } from "../yandex/media.ts";
import { enrichCardMetaColor, metaNeedsWaveColor } from "../yandex/metadata.ts";
import type { CardMeta } from "../yandex/types.ts";
import type { Container } from "./container.ts";
import { errText, type MintedCard } from "./richMessage.ts";
import type { ApiBot } from "./types.ts";

const log = getLogger("bot.card_builder");

// аватара нет → не дёргаем Telegram каждый рендер (кэш отрицательного ответа)
const AVATAR_NEG_TTL = 30 * 60;

/** Аватар юзера из Telegram → круглый кроп рисует карточка. Кэшируется
 * (и положительный, и отрицательный ответ), чтобы не ходить в API на каждый рендер. */
async function fetchUserAvatar(bot: ApiBot, userId: number, container: Container): Promise<Buffer | null> {
  const key = `avatar:${userId}`;
  const cache = container.avatarCache;
  const cached = cache.get(key);
  if (cached != null) return cached.length === 0 ? null : cached;

  try {
    const photos = await bot.api.getUserProfilePhotos({ user_id: userId, limit: 1 });
    if (!photos.total_count || photos.photos.length === 0) {
      cache.set(key, Buffer.alloc(0), AVATAR_NEG_TTL);
      return null;
    }
    const sizes = photos.photos[0]!;
    const photo = sizes[sizes.length - 1]!;
    const { bytes } = await bot.api.downloadFile(photo.file_id);
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    cache.set(key, data);
    return data;
  } catch (e) {
    log.debug(`[card] аватар не достал user=${userId}: ${errText(e)}`);
    // без этого юзер с постоянно падающим getUserProfilePhotos (приватность,
    // транзиентный 400) дёргал бы Telegram на каждый рендер карточки
    cache.set(key, Buffer.alloc(0), AVATAR_NEG_TTL);
    return null;
  }
}

export interface CardBuildInput {
  bot: ApiBot;
  container: Container;
  userId: number;
  /** нужен только для wave-цвета (yandex-клиент). null → карточка рендерится без enrich. */
  token: string | null;
  coverUrl: string;
  title: string;
  artist: string;
  progressMs: number;
  durationMs: number;
  paused: boolean;
  /** не рисовать линию прогресса и тайминги. */
  hideProgress?: boolean;
  senderHandle: string | null;
  meta: CardMeta;
  settings: Pick<UserSettings, "card_toggles" | "card_progress" | "card_style" | "card_aspect">;
  /** лирик-режим: лента строк вместо прогресса. null/отсутствует → обычная карточка. */
  lyrics?: LyricsBlock | null;
}

/** JPEG-байты карточки. Все сетевые операции — параллельно. */
export async function buildCardImage(input: CardBuildInput): Promise<Buffer> {
  const { bot, container, userId, token, meta, settings } = input;
  const toggles = settings.card_toggles;
  const avatarEnabled = Boolean(toggles.avatar);
  const needColor = metaNeedsWaveColor(meta) && token !== null;

  // wave-цвет требует яндекс-клиента — поднимаем его только при необходимости
  const colorTask: Promise<void> = needColor
    ? container
        .getYandexService(token!, userId)
        .then((yandex) => enrichCardMetaColor(meta, yandex))
        .catch((e) => {
          log.debug(`[card] wave-цвет не подтянут: ${errText(e)}`);
        })
    : Promise.resolve();

  const [coverBytes, senderAvatar] = await Promise.all([
    input.coverUrl ? fetchCover(input.coverUrl, container.httpClient) : Promise.resolve(null),
    avatarEnabled ? fetchUserAvatar(bot, userId, container) : Promise.resolve(null),
    colorTask,
  ]);

  // рендер идёт в worker_threads — canvas.encode() иначе блокирует event loop
  // главного потока на ~50-100мс, задерживая карточки всех остальных пользователей.
  return container.cardRenderPool.render({
    coverBytes,
    title: input.title,
    artist: input.artist,
    progressMs: input.progressMs,
    durationMs: input.durationMs,
    paused: input.paused,
    hideProgress: input.hideProgress ?? false,
    senderHandle: input.senderHandle,
    senderAvatar,
    botUsername: container.botUsername,
    meta,
    cardOptions: {
      toggles,
      progress: settings.card_progress,
      style: settings.card_style,
      aspect: settings.card_aspect,
    },
    lyrics: input.lyrics ?? null,
  });
}

/** Telegram не даёт залить буфер в editMessageMedia/rich_message по inline_message_id
 * (только file_id/URL) — минтим file_id аплоадом в служебный канал. Под бёрстом аплоад
 * ловит 429 — ретраим по retry_after. release() удаляет копию в канале (best-effort,
 * не бросает, идемпотентен): file_id ссылается на файл в хранилище tg, не на сообщение. */
export async function mintCardFileId(
  bot: ApiBot,
  channelId: number | string,
  image: Buffer,
  tag: string,
): Promise<MintedCard> {
  const msg = await floodRetry(
    () => bot.api.sendPhoto({ chat_id: channelId, photo: media.buffer(image, "now_playing.jpg") }),
    {
      attempts: 3,
      graceMs: 500,
      onWait: (ra, n) => log.warning(`[chosen] карточка ${tag}: 429, ждём ${ra}s (попытка ${n}/3)`),
    },
  );
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    void Promise.resolve()
      .then(() => bot.api.deleteMessage({ chat_id: channelId, message_id: msg.message_id }))
      .catch(() => undefined);
  };
  const fileId = msg.photo?.at(-1)?.file_id;
  if (!fileId) {
    release();
    throw new Error(`карточка ${tag}: telegram не вернул file_id`);
  }
  return { fileId, release };
}
