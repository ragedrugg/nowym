/** Выгрузка альбома: параллельная подготовка → пачками по 10 через sendMediaGroup. */

import type { InputMediaAudio } from "@yaebal/types";
import { bold, code, type FormatResult, format, join, media } from "yaebal";
import { albumRetryMarkup, cancelAlbumMarkup } from "../bot/markup.ts";
import {
  ALBUM_NOUN,
  downloadingInParallel,
  etaLeft,
  FAILED_LIST_HEADER,
  nowSendingBatch,
  nowSendingTrack,
  PLAYLIST_NOUN,
  PREPARING_SEND,
  resumeAlreadyDone,
  resumeContinue,
  resumeGone,
  resumeNeedsLogin,
  sendingNow,
  TOO_LONG_MARK,
  UPLOAD_DONE,
  uploadCancelled,
} from "../bot/texts.ts";
import type { ApiBot } from "../bot/types.ts";
import { floodRetry } from "../infra/floodRetry.ts";
import { collectGarbage } from "../infra/gc.ts";
import type { HttpClient } from "../infra/http.ts";
import { getLogger } from "../infra/logging.ts";
import { LRUMap } from "../infra/lruMap.ts";
import type { DownloadConcurrency } from "../infra/queue.ts";
import { Semaphore } from "../infra/semaphore.ts";
import { pluralTracks } from "../infra/text.ts";
import { getSettings } from "../settings.ts";
import type { CacheDb } from "../storage/cache.ts";
import type { UserSettings } from "../storage/settings.ts";
import type { CachedTrack, InflightAlbum } from "../storage/types.ts";
import { losslessUrlPicker, type YandexClient } from "../yandex/client.ts";
import { fetchCover } from "../yandex/media.ts";
import {
  type AudioQuality,
  albumEmoji,
  albumTypeRu,
  buildTrackMetadata,
  formatTrackBasics,
  LABELED_ALBUM_TYPES,
  trackIsTooLong,
} from "../yandex/metadata.ts";
import type { AlbumData, YaTrack } from "../yandex/types.ts";
import type { CacheMetadata, CacheService } from "./cache.ts";

const log = getLogger("services.albums");

const RETRY_BUFFER_MAX = 100;
const RETRY_BUFFER_TTL_MS = 1_800_000; // 30 мин и кнопка retry перестаёт работать

const BAR_WIDTH = 16;
const BAR_FILLED = "▓";
const BAR_EMPTY = "░";

const MEDIA_GROUP_MAX = 10; // лимит tg на одну sendMediaGroup-пачку

// сколько треков готовим в RAM за одну волну — без этого лимита аудиокнига
// на 100+ глав разнесла бы по памяти все буферы разом. Semaphore(sem) ниже
// ограничивает только параллельность СКАЧИВАНИЯ, а не удержание в памяти —
// вся волна оседает в prepared[] до отправки, поэтому волна = размер пачки
// sendMediaGroup: как только 10 треков подготовлены, тут же уходят и
// освобождают буферы, вместо накопления до 25 (на lossless-альбоме это
// разница между ~800мб и ~5гб при тяжёлых FLAC).
const PREPARE_CHUNK = MEDIA_GROUP_MAX;

// 429 в чат юзера на больших альбомах: без ретрая вся пачка из 10 уходила в «❌ не вышло».
const FLOOD_ATTEMPTS = 3;
const floodToUser = <T>(build: () => Promise<T>): Promise<T> =>
  floodRetry(build, {
    attempts: FLOOD_ATTEMPTS,
    graceMs: 500,
    onWait: (ra, attempt) => log.warning(`flood 429 в чат: ждём ${ra}s (попытка ${attempt}/${FLOOD_ATTEMPTS})`),
  });

export function renderProgressBar(current: number, total: number): string {
  if (total <= 0) return BAR_EMPTY.repeat(BAR_WIDTH);
  const filled = Math.min(BAR_WIDTH, Math.max(0, Math.round((BAR_WIDTH * current) / total)));
  return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_WIDTH - filled);
}

export function formatEta(seconds: number): string {
  if (seconds < 0 || Number.isNaN(seconds)) return "?";
  const s = Math.floor(seconds);
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** обёртка над editMessageText по chat_id+message_id — работает и для resume,
 * где известен только id сообщения. */
export class ProgressMessage {
  private bot: ApiBot;
  public chatId: number;
  public messageId: number;

  constructor(bot: ApiBot, chatId: number, messageId: number) {
    this.bot = bot;
    this.chatId = chatId;
    this.messageId = messageId;
  }

  async edit(text: FormatResult, markup?: ReturnType<typeof cancelAlbumMarkup>): Promise<void> {
    try {
      await this.bot.api.editMessageText({
        chat_id: this.chatId,
        message_id: this.messageId,
        text,
        ...(markup ? { reply_markup: markup } : {}),
      } as never);
    } catch {
      // not modified / message deleted — игнор
    }
  }
}

interface RetryBuf {
  chatId: number;
  userId: number;
  tracks: YaTrack[];
  albumData: AlbumData;
  yandex: YandexClient;
}

// too_long — >4.5 ч: в телеграм не влезет никогда, в retry-буфер не кладём
type PrepareKind = "cached" | "fresh" | "failed" | "too_long";
interface PreparedEntry {
  kind: PrepareKind;
  track: YaTrack;
  trackId: string;
  metadata: CacheMetadata;
  // cached → fileId; fresh → [audio, cover]; failed → null
  fileId: string | null;
  payload: [Buffer, Buffer | null] | null;
  codec: string;
  // тир кэша файла: 'lossy' | 'lossless' (фактический — после возможного фолбэка).
  tier: string;
}

interface ProgressState {
  sent: number;
  downloading: number;
  failed: YaTrack[];
  /** слишком длинные — показываем отдельно, «повторить» их не касается. */
  tooLong: YaTrack[];
  lock: Semaphore;
  startedAt: number;
  lastRender: number;
  nowSending: string | null;
}

interface SendArgs {
  chatId: number;
  userId: number;
  albumData: AlbumData;
  progressMsg: ProgressMessage | null;
  yandex: YandexClient;
  coverBytes?: Buffer | null;
}

export class AlbumService {
  private active = new Map<number, { cancelled: boolean }>();
  // LRU-cap + TTL-свип старых записей
  private retryBuffer = new LRUMap<number, { ts: number; buf: RetryBuf }>(RETRY_BUFFER_MAX);

  private db: CacheDb;
  private cache: CacheService;
  private downloadQueue: DownloadConcurrency;
  private http: HttpClient;
  private bot: ApiBot;
  private getUserSettings: (userId: number) => Promise<UserSettings>;

  constructor(
    db: CacheDb,
    cache: CacheService,
    downloadQueue: DownloadConcurrency,
    http: HttpClient,
    bot: ApiBot,
    getUserSettings: (userId: number) => Promise<UserSettings>,
  ) {
    this.db = db;
    this.cache = cache;
    this.downloadQueue = downloadQueue;
    this.http = http;
    this.bot = bot;
    this.getUserSettings = getUserSettings;
  }

  cancel(userId: number): boolean {
    const state = this.active.get(userId);
    if (state === undefined) return false;
    state.cancelled = true;
    return true;
  }

  isActive(userId: number): boolean {
    return this.active.has(userId);
  }

  /** Синхронно занимает слот выгрузки; false — у юзера уже идёт выгрузка.
   *  Слот живёт до finally sendAlbumTracks; иначе освобождать через release(). */
  tryBegin(userId: number): boolean {
    if (this.active.has(userId)) return false;
    this.active.set(userId, { cancelled: false });
    return true;
  }

  release(userId: number): void {
    this.active.delete(userId);
  }

  /** не трогает буфер — только для проверки владельца/актуальности до take(). */
  peekRetry(messageId: number): RetryBuf | null {
    const item = this.retryBuffer.peek(messageId);
    if (item === undefined) return null;
    if (Date.now() - item.ts > RETRY_BUFFER_TTL_MS) return null;
    return item.buf;
  }

  popRetry(messageId: number): RetryBuf | null {
    const item = this.retryBuffer.take(messageId);
    if (item === undefined) return null;
    if (Date.now() - item.ts > RETRY_BUFFER_TTL_MS) return null;
    return item.buf;
  }

  /** logout/смена аккаунта: retry-буфер держит YandexClient (токен) юзера до 30 мин — выкидываем. */
  forgetUser(userId: number): void {
    for (const [mid, { buf }] of this.retryBuffer.entries()) {
      if (buf.userId === userId) this.retryBuffer.delete(mid);
    }
  }

  private putRetry(messageId: number, buf: RetryBuf): void {
    const now = Date.now();
    for (const [mid, { ts }] of this.retryBuffer.entries()) {
      if (now - ts > RETRY_BUFFER_TTL_MS) this.retryBuffer.delete(mid);
    }
    this.retryBuffer.set(messageId, { ts: now, buf });
  }

  async sendAlbum(args: SendArgs): Promise<void> {
    await this.sendAlbumTracks({
      chatId: args.chatId,
      userId: args.userId,
      tracks: args.albumData.tracks,
      albumData: args.albumData,
      progressMsg: args.progressMsg,
      yandex: args.yandex,
      coverBytes: args.coverBytes ?? null,
      persistInflight: true,
    });
  }

  /** false — слот уже занят (гонка с параллельным стартом/резюме между проверкой
   *  вызывающей стороны и этим await'ом); true — выгрузка реально стартовала. */
  async retryFailed(args: {
    chatId: number;
    userId: number;
    tracks: YaTrack[];
    albumData: AlbumData;
    progressMsg: ProgressMessage | null;
    yandex: YandexClient;
  }): Promise<boolean> {
    // claim — первым же синхронным действием, до всех await'ов вызывающей стороны
    if (!this.tryBegin(args.userId)) return false;
    // ретрай не персистим — юзер сам инициировал, если упадём пусть тыкнет ещё раз
    await this.sendAlbumTracks({
      chatId: args.chatId,
      userId: args.userId,
      tracks: args.tracks,
      albumData: args.albumData,
      progressMsg: args.progressMsg,
      yandex: args.yandex,
      coverBytes: null,
      persistInflight: false,
    });
    return true;
  }

  /** на старте бота дочитывает альбомы, упавшие на середине. */
  async resumeInflight(deps: {
    resolveToken(userId: number): Promise<string | null>;
    getYandexClient(token: string, userId: number): Promise<YandexClient>;
  }): Promise<void> {
    let rows: InflightAlbum[];
    try {
      rows = await this.db.listInflight(6);
    } catch (e) {
      log.warning(`[resume] не получили список inflight: ${e}`);
      return;
    }

    try {
      const purged = await this.db.deleteOldInflight(6);
      if (purged) log.info(`[resume] очищено ${purged} протухших inflight`);
    } catch (e) {
      log.warning(`[resume] cleanup: ${e}`);
    }

    if (rows.length === 0) return;
    log.info(`[resume] подхватываю ${rows.length} незавершённых альбомов`);
    for (const row of rows) {
      try {
        await this.resumeOne(deps, row);
      } catch (e) {
        log.error(`[resume] row=${row.id}: ${e}`);
      }
    }
  }

  private async resumeOne(
    deps: {
      resolveToken(userId: number): Promise<string | null>;
      getYandexClient(token: string, userId: number): Promise<YandexClient>;
    },
    row: {
      id: number;
      user_id: number;
      chat_id: number;
      album_id: number;
      playlist_owner: string | null;
      progress_message_id: number | null;
      completed_track_ids: number[];
    },
  ): Promise<void> {
    const userId = row.user_id;
    const chatId = row.chat_id;
    const albumId = row.album_id;
    // плейлист: album_id = kind, перезапрашиваем по (owner, kind), а не getAlbum(kind)
    const owner = row.playlist_owner;
    const noun = owner ? PLAYLIST_NOUN : ALBUM_NOUN;
    const doneIds = new Set(row.completed_track_ids.map(Number));
    const inflightId = row.id;

    const proxy = row.progress_message_id ? new ProgressMessage(this.bot, chatId, row.progress_message_id) : null;

    // claim — синхронно, до await'ов ниже; bot.start() уже принимает апдейты
    // параллельно с resumeInflight, так что новый /start album_<id> от того же
    // юзера мог бы иначе проскочить в ту же гонку, что и retryFailed.
    if (!this.tryBegin(userId)) {
      log.info(`[resume] user=${userId} уже активен, пропускаю`);
      return;
    }

    // после tryBegin всё под try/finally: resolveToken/getYandexClient (сетевой
    // lib.init)/deleteInflight могут бросить — без finally слот утёк бы до рестарта.
    let handedOff = false;
    try {
      const token = await deps.resolveToken(userId);
      if (!token) {
        if (proxy) await proxy.edit(resumeNeedsLogin(noun));
        await this.db.deleteInflight(inflightId);
        return;
      }

      const yandex = await deps.getYandexClient(token, userId);
      let album: AlbumData | null;
      try {
        album = owner ? await yandex.getPlaylist(owner, albumId) : await yandex.getAlbum(albumId);
      } catch (e) {
        log.warning(`[resume] ${noun} ${owner ? `${owner}/` : ""}${albumId} user=${userId}: ${e}`);
        album = null;
      }

      if (!album) {
        if (proxy) await proxy.edit(resumeGone(noun));
        await this.db.deleteInflight(inflightId);
        return;
      }

      const remaining = album.tracks.filter((t) => !doneIds.has(Number(t.id)));
      const totalOrig = album.tracks.length;

      if (remaining.length === 0) {
        if (proxy) await proxy.edit(resumeAlreadyDone(noun));
        await this.db.deleteInflight(inflightId);
        return;
      }

      const done = totalOrig - remaining.length;
      if (proxy) {
        await proxy.edit(resumeContinue(done, totalOrig, remaining.length));
      }

      handedOff = true; // дальше слот ведёт sendAlbumTracks (его finally чистит active)
      await this.sendAlbumTracks({
        chatId,
        userId,
        tracks: remaining,
        albumData: album,
        progressMsg: proxy,
        yandex,
        coverBytes: null,
        persistInflight: true,
        inflightId,
      });
    } finally {
      if (!handedOff) this.release(userId);
    }
  }

  async sendCover(chatId: number, coverUrl: string, caption: FormatResult): Promise<Buffer | null> {
    if (!coverUrl) return null;
    try {
      const data = await fetchCover(coverUrl, this.http);
      if (!data) return null;
      await this.bot.api.sendPhoto({
        chat_id: chatId,
        photo: media.buffer(data, "cover.jpg"),
        caption,
      });
      return data;
    } catch (e) {
      log.warning(`не вышло отправить обложку (chat=${chatId} url=${coverUrl}): ${e}`);
      return null;
    }
  }

  private async sendAlbumTracks(args: {
    chatId: number;
    userId: number;
    tracks: YaTrack[];
    albumData: AlbumData;
    progressMsg: ProgressMessage | null;
    yandex: YandexClient;
    coverBytes: Buffer | null;
    persistInflight: boolean;
    inflightId?: number | null;
  }): Promise<void> {
    const { chatId, userId, tracks, albumData, progressMsg, yandex, coverBytes } = args;
    const total = tracks.length;
    let inflightId = args.inflightId ?? null;
    // весь путь — под одним try/finally: слот active (занятый tryBegin вызывающей
    // стороной) обязан освободиться, даже если упал getUserSettings/insertInflight
    // (pg моргнул) — иначе «у тебя уже идёт выгрузка» навсегда до рестарта.
    try {
      if (total === 0) return;

      // режим качества юзера: lossless → весь альбом во FLAC (отдельный тир кэша),
      // с пофайловым фолбэком на lossy, если у трека нет lossless; economy (≤192) — свой тир,
      // как у одиночного трека (inline/ensure.ts lossyTier), оптимальное не подменяет.
      const quality = (await this.getUserSettings(userId)).track_quality as AudioQuality;
      const losslessMode = quality === "lossless";
      const economyMode = quality === "economy";
      const lossyTier = economyMode ? "economy" : "lossy";
      const tier = losslessMode ? "lossless" : lossyTier;

      if (args.persistInflight && inflightId === null) {
        try {
          inflightId = await this.db.insertInflightAlbum({
            user_id: userId,
            chat_id: chatId,
            album_id: albumData.id || 0,
            playlist_owner: albumData.playlist_owner ?? null,
            progress_message_id: progressMsg?.messageId ?? null,
          });
        } catch (e) {
          log.warning(`[inflight] не вышло записать row: ${e}`);
          inflightId = null;
        }
      }

      const multiDisc = (albumData.volumes?.length ?? 0) > 1;
      const trackTotal = albumData.tracks.length;
      const discTotal = albumData.volumes?.length || null;

      const headerShort = format`${albumEmoji(albumData.album_type)} ${bold(`${albumData.artist} — ${albumData.title}`)}`;
      const metaParts = [albumData.year, albumData.label, pluralTracks(trackTotal)].filter(Boolean) as string[];
      if (LABELED_ALBUM_TYPES.has(albumData.album_type.toLowerCase())) {
        const typeLabel = albumTypeRu(albumData.album_type, trackTotal);
        if (typeLabel) metaParts.unshift(typeLabel);
      }
      const metaLine = metaParts.join(", ");
      const headerFull = metaLine ? format`${headerShort}\n${metaLine}` : headerShort;

      const buildMeta = (track: YaTrack, i: number): CacheMetadata => {
        const trackNumber = track._trackNumber ?? i;
        const discNumber = multiDisc ? (track._discNumber ?? 1) : null;
        const meta: CacheMetadata = buildTrackMetadata(track, {
          title: albumData.title,
          year: albumData.year,
          label: albumData.label,
          genre: albumData.genre || undefined,
          cover_url: albumData.cover_url,
          track_number: trackNumber,
          track_total: trackTotal,
          ...(discNumber !== null ? { disc_number: discNumber } : {}),
          ...(discTotal !== null ? { disc_total: discTotal } : {}),
        });
        if (coverBytes !== null) meta.cover_data = coverBytes;
        return meta;
      };

      // переиспользуем резерв tryBegin (если был), иначе cancel между резервом и стартом терялся бы
      const state = this.active.get(userId) ?? { cancelled: false };
      this.active.set(userId, state);

      const progress: ProgressState = {
        sent: 0,
        downloading: 0,
        failed: [],
        tooLong: [],
        lock: new Semaphore(1),
        startedAt: performance.now() / 1000,
        lastRender: 0,
        nowSending: null,
      };

      const sem = new Semaphore(Math.max(1, getSettings().ALBUM_PARALLEL_TRACKS));

      const markDoneSafe = async (tid: string): Promise<void> => {
        if (inflightId === null) return;
        try {
          await this.db.markInflightTrackDone(inflightId, Number(tid));
        } catch (e) {
          log.debug(`[inflight] mark_done track=${tid}: ${e}`);
        }
      };

      const prepared: (PreparedEntry | null)[] = new Array(total).fill(null);

      const prepare = async (idx: number, track: YaTrack): Promise<void> => {
        const trackId = String(track.id);
        const metadata = buildMeta(track, idx + 1);

        if (trackIsTooLong(track)) {
          log.info(`[album] трек ${trackId} «${track.title}» длинный, пропускаю`);
          prepared[idx] = {
            kind: "too_long",
            track,
            trackId,
            metadata,
            fileId: null,
            payload: null,
            codec: "mp3",
            tier,
          };
          return;
        }

        let cached: CachedTrack | null;
        try {
          cached = await this.db.get(trackId, tier);
        } catch {
          cached = null;
        }

        if (cached && cached.is_cached) {
          prepared[idx] = {
            kind: "cached",
            track,
            trackId,
            metadata,
            fileId: cached.telegram_file_id,
            payload: null,
            codec: "mp3",
            tier,
          };
          return;
        }

        await sem.run(async () => {
          if (state.cancelled) {
            prepared[idx] = {
              kind: "failed",
              track,
              trackId,
              metadata,
              fileId: null,
              payload: null,
              codec: "mp3",
              tier,
            };
            return;
          }

          await this.mutateProgress(progress, (p) => {
            p.downloading += 1;
          });
          await this.renderProgress(progressMsg, headerFull, progress, total);

          let codec = "mp3";
          let payload: [Buffer, Buffer | null] | null = null;
          let actualTier = lossyTier;
          try {
            const result = await this.downloadQueue.enqueue(async () => {
              // lossless-режим: raw flac-mp4 через get-file-info (lossy-ответ = null → фолбэк в lossy-тир).
              if (losslessMode) {
                const ll = await yandex.getLosslessDownload(track);
                if (ll !== null) {
                  metadata.codec = ll.codec;
                  metadata.bitrate_kbps = ll.bitrate;
                  // каждая racing-попытка берёт случайный url; протухший список обновляется один раз.
                  const pickUrl = losslessUrlPicker(ll, () => yandex.getLosslessDownload(track));
                  const llCodec = ll.codec ?? "flac";
                  const p = await this.cache.prepareTrackPayload(trackId, pickUrl, metadata, llCodec, "lossless");
                  if (p !== null) return { codec: llCodec, payload: p, tier: "lossless" };
                  log.warning(`[album] lossless не вышел для ${trackId} → фолбэк на lossy`);
                }
                // фолбэк: трек без lossless или сбой — качаем lossy ниже.
              }
              const info = await yandex.getBestDownloadInfo(track, economyMode ? "economy" : "best");
              if (info === null) return null;
              metadata.codec = info.codec;
              metadata.bitrate_kbps = info.bitrateInKbps;
              const p = await this.cache.prepareTrackPayload(
                trackId,
                () => yandex.directLinkFromInfo(info),
                metadata,
                info.codec,
                lossyTier,
              );
              if (p === null) return null;
              return { codec: info.codec, payload: p, tier: lossyTier };
            });
            if (result !== null) {
              codec = result.codec;
              payload = result.payload;
              actualTier = result.tier;
            }
          } catch (e) {
            log.error(`ошибка скачивания трека ${trackId} (user=${userId}): ${e}`);
          } finally {
            await this.mutateProgress(progress, (p) => {
              p.downloading -= 1;
            });
          }

          if (payload === null) {
            prepared[idx] = {
              kind: "failed",
              track,
              trackId,
              metadata,
              fileId: null,
              payload: null,
              codec,
              tier: actualTier,
            };
          } else {
            prepared[idx] = { kind: "fresh", track, trackId, metadata, fileId: null, payload, codec, tier: actualTier };
          }
        });
      };

      // волнами по PREPARE_CHUNK, а не «подготовить всё разом»: без этого аудио-буферы
      // сотни глав аудиокниги копились бы в RAM одновременно до начала отправки → OOM.
      for (let chunkStart = 0; chunkStart < total; chunkStart += PREPARE_CHUNK) {
        if (state.cancelled) break;
        const chunkEnd = Math.min(chunkStart + PREPARE_CHUNK, total);

        await Promise.allSettled(tracks.slice(chunkStart, chunkEnd).map((t, i) => prepare(chunkStart + i, t)));
        if (state.cancelled) break;

        // phase 2: пачки до 10 внутри волны. failed-трек — «разрыв», флашим текущую пачку перед ним
        let cursor = chunkStart;
        while (cursor < chunkEnd) {
          if (state.cancelled) break;
          const batch: PreparedEntry[] = [];
          const batchIdx: number[] = [];
          while (cursor < chunkEnd && batch.length < MEDIA_GROUP_MAX) {
            const entry = prepared[cursor];
            if (entry == null || entry.kind === "failed" || entry.kind === "too_long") {
              if (batch.length > 0) break; // сначала отправим что собрали
              if (entry != null) {
                const failedTrack = entry.track;
                const tooLong = entry.kind === "too_long";
                await this.mutateProgress(progress, (p) => {
                  if (tooLong) p.tooLong.push(failedTrack);
                  else p.failed.push(failedTrack);
                });
              }
              prepared[cursor] = null;
              cursor += 1;
              continue;
            }
            batch.push(entry);
            batchIdx.push(cursor);
            cursor += 1;
          }
          if (batch.length > 0) {
            await this.sendBatch(chatId, batch, progress, total, progressMsg, headerFull, markDoneSafe);
            // освобождаем ссылку, чтобы GC мог забрать буфер до старта следующей волны
            for (const idx of batchIdx) prepared[idx] = null;
          }
        }
      }

      if (state.cancelled) {
        await this.safeEdit(progressMsg, uploadCancelled(headerShort, progress.sent, total));
        return;
      }

      await this.finishMessage({
        msg: progressMsg,
        headerShort,
        total,
        failed: progress.failed,
        tooLong: progress.tooLong,
        albumData,
        userId,
        chatId,
        yandex,
        elapsed: performance.now() / 1000 - progress.startedAt,
      });
    } finally {
      this.active.delete(userId);
      if (inflightId !== null) {
        try {
          await this.db.deleteInflight(inflightId);
        } catch (e) {
          log.debug(`[inflight] delete row=${inflightId}: ${e}`);
        }
      }
      collectGarbage(`альбом user=${userId}`);
    }
  }

  private async sendBatch(
    chatId: number,
    batch: PreparedEntry[],
    progress: ProgressState,
    total: number,
    progressMsg: ProgressMessage | null,
    headerFull: FormatResult,
    markDoneSafe: (tid: string) => Promise<void>,
  ): Promise<void> {
    if (batch.length === 0) return;

    // phase 2a: pre-upload fresh → канал → file_id
    const promoted: PreparedEntry[] = [];
    for (const entry of batch) {
      if (entry.kind === "fresh") {
        await this.mutateProgress(progress, (p) => {
          p.nowSending = nowSendingTrack(entry.track.title || "?");
        });
        await this.renderProgress(progressMsg, headerFull, progress, total);
        const [audioBytes, coverBytes] = entry.payload!;
        const fileId = await this.cache.uploadToChannel(
          entry.trackId,
          audioBytes,
          coverBytes,
          entry.metadata,
          entry.codec,
          entry.tier,
        );
        if (fileId === null) {
          await this.mutateProgress(progress, (p) => {
            p.failed.push(entry.track);
          });
          continue;
        }
        promoted.push({ ...entry, kind: "cached", fileId });
      } else {
        promoted.push(entry);
      }
    }

    if (promoted.length === 0) {
      await this.mutateProgress(progress, (p) => {
        p.nowSending = null;
      });
      await this.renderProgress(progressMsg, headerFull, progress, total);
      return;
    }

    // phase 2b: пачкой в чат юзера
    await this.mutateProgress(progress, (p) => {
      p.nowSending =
        promoted.length === 1 ? nowSendingTrack(promoted[0]!.track.title || "?") : nowSendingBatch(promoted.length);
    });
    await this.renderProgress(progressMsg, headerFull, progress, total);

    if (promoted.length === 1) {
      const entry = promoted[0]!;
      let ok = false;
      try {
        await floodToUser(() => this.bot.api.sendAudio({ chat_id: chatId, audio: entry.fileId! }));
        ok = true;
      } catch (e) {
        log.error(`send_audio failed for ${entry.trackId}: ${e}`);
      }
      await this.mutateProgress(progress, (p) => {
        if (ok) p.sent += 1;
        else p.failed.push(entry.track);
      });
      if (ok) await markDoneSafe(entry.trackId);
    } else {
      let sentMsgs: unknown[] = [];
      try {
        sentMsgs = (await floodToUser(() =>
          this.bot.api.sendMediaGroup({ chat_id: chatId, media: promoted.map((e) => this.buildInputMedia(e)) }),
        )) as unknown[];
      } catch (e) {
        log.error(`send_media_group failed: ${e}`);
      }
      if (!sentMsgs || sentMsgs.length !== promoted.length) {
        await this.mutateProgress(progress, (p) => {
          for (const entry of promoted) p.failed.push(entry.track);
        });
      } else {
        await this.mutateProgress(progress, (p) => {
          p.sent += promoted.length;
        });
        for (const entry of promoted) await markDoneSafe(entry.trackId);
      }
    }

    await this.mutateProgress(progress, (p) => {
      p.nowSending = null;
    });
    await this.renderProgress(progressMsg, headerFull, progress, total);
  }

  /** InputMediaAudio по file_id (у yaebal нет хелпера MediaInput.audio — литерал той же формы). */
  private buildInputMedia(entry: PreparedEntry): InputMediaAudio {
    const [artist, title] = formatTrackBasics(entry.track, "");
    return {
      type: "audio",
      media: entry.fileId!,
      title,
      performer: artist,
      duration: entry.metadata.duration || 0,
    };
  }

  private async renderProgress(
    progressMsg: ProgressMessage | null,
    headerFull: FormatResult,
    progress: ProgressState,
    total: number,
  ): Promise<void> {
    let text: FormatResult | null = null;
    await progress.lock.run(async () => {
      const now = performance.now() / 1000;
      if (now - progress.lastRender < 1.5 && progress.sent < total) return;
      progress.lastRender = now;

      const sent = progress.sent;
      const downloading = progress.downloading;
      const elapsed = now - progress.startedAt;
      const bar = renderProgressBar(sent, total);
      let eta = "";
      if (sent > 0 && sent < total) eta = etaLeft(formatEta((elapsed / sent) * (total - sent)));

      const sendingLine = progress.nowSending ? sendingNow(progress.nowSending) : format`${PREPARING_SEND}`;
      const downloadingLine = downloading ? downloadingInParallel(pluralTracks(downloading)) : null;

      let t = format`${headerFull}\n\n${code(bar)} ${sent}/${total}${eta}\n${sendingLine}`;
      if (downloadingLine) t = format`${t}\n${downloadingLine}`;
      text = t;
    });
    if (text !== null) await this.safeEdit(progressMsg, text, cancelAlbumMarkup());
  }

  /** мутирует ProgressState под локом — сериализует конкурентные prepare()-таски. */
  private async mutateProgress<T>(progress: ProgressState, fn: (p: ProgressState) => T): Promise<T> {
    return progress.lock.run(async () => fn(progress));
  }

  private async safeEdit(
    msg: ProgressMessage | null,
    text: FormatResult,
    markup?: ReturnType<typeof cancelAlbumMarkup>,
  ): Promise<void> {
    if (msg === null) return;
    await msg.edit(text, markup);
  }

  private async finishMessage(args: {
    msg: ProgressMessage | null;
    headerShort: FormatResult;
    total: number;
    failed: YaTrack[];
    tooLong?: YaTrack[];
    albumData: AlbumData;
    userId: number;
    chatId: number;
    yandex: YandexClient;
    elapsed: number;
  }): Promise<void> {
    const { msg, headerShort, total, failed, albumData, userId, chatId, yandex, elapsed } = args;
    const tooLong = args.tooLong ?? [];
    if (msg === null) return;
    const bar = renderProgressBar(total, total);
    const elapsedStr = formatEta(elapsed);

    if (failed.length > 0 || tooLong.length > 0) {
      const lines = [
        ...failed.map((t) => format`- ${t.title}`),
        ...tooLong.map((t) => format`- ${t.title} ${TOO_LONG_MARK}`),
      ];
      const failedList = join(lines, (l) => l, "\n");
      const done = total - failed.length - tooLong.length;
      const text = format`${headerShort}\n${code(bar)} ${done}/${total}, за ${elapsedStr}\n\n${FAILED_LIST_HEADER}\n${failedList}`;
      if (failed.length === 0) {
        await msg.edit(text); // повторять нечего: длинные треки не пройдут никогда
        return;
      }
      this.putRetry(msg.messageId, { chatId, userId, tracks: failed, albumData, yandex });
      await msg.edit(text, albumRetryMarkup(msg.messageId, pluralTracks(failed.length)));
    } else {
      const text = format`${headerShort}\n${code(bar)} ${total}/${total}, за ${elapsedStr}\n${UPLOAD_DONE}`;
      await msg.edit(text);
    }
  }
}
