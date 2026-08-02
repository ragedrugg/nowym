/** Сборка карточки «сейчас играет»: параллельно тянет обложку, аватар и (если
 * нужно) wave-цвет, затем рендерит. Общая точка входа для /np и inline-карточки.
 * `enrichCardMetaLiked` не вызывается — лайк живёт кнопкой на треке, не на карточке. */
import type { Bot } from "gramio";
import { getLogger } from "../infra/logging.ts";
import type { LyricsBlock } from "../services/card.ts";
import type { UserSettings } from "../storage/settings.ts";
import { fetchCover } from "../yandex/media.ts";
import { enrichCardMetaColor, metaNeedsWaveColor } from "../yandex/metadata.ts";
import type { CardMeta } from "../yandex/types.ts";
import type { Container } from "./container.ts";

const log = getLogger("bot.card_builder");

// аватара нет → не дёргаем Telegram каждый рендер (кэш отрицательного ответа)
const AVATAR_NEG_TTL = 30 * 60;

/** Аватар юзера из Telegram → круглый кроп рисует карточка. Кэшируется
 * (и положительный, и отрицательный ответ), чтобы не ходить в API на каждый рендер. */
async function fetchUserAvatar(bot: Bot, userId: number, container: Container): Promise<Buffer | null> {
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
    const ab = await bot.downloadFile(photo.file_id);
    const data = Buffer.from(ab as ArrayBuffer);
    cache.set(key, data);
    return data;
  } catch (e) {
    log.debug(`[card] аватар не достал user=${userId}: ${e}`);
    // без этого юзер с постоянно падающим getUserProfilePhotos (приватность,
    // транзиентный 400) дёргал бы Telegram на каждый рендер карточки
    cache.set(key, Buffer.alloc(0), AVATAR_NEG_TTL);
    return null;
  }
}

export interface CardBuildInput {
  bot: Bot;
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
          log.debug(`[card] wave-цвет не подтянут: ${e}`);
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
