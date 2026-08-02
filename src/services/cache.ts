/** Кэш треков в Telegram-канале.
 *
 * Двухфазно: на inline-поиске создаём «пустышку» (1с mp3), file_id отдаётся
 * мгновенно. При выборе результата — реальная загрузка в канал, file_id в БД
 * перезаписывается, старая пустышка удаляется фоном.
 *
 * Отправку в канал делегируем интерфейсу TelegramSender (ChannelSender поверх
 * GramIO; flood-control 429 обрабатывается его floodRetry). */

import { sleep, withTimeout } from "../infra/async.ts";
import type { HttpClient } from "../infra/http.ts";
import { getLogger } from "../infra/logging.ts";
import { Semaphore } from "../infra/semaphore.ts";
import type { CacheDb } from "../storage/cache.ts";
import type { TrackCacheResult } from "../storage/types.ts";
import { createEmptyMp3, getFilename } from "../tagging/emptyMp3.ts";
import type { AudioTransform, TaggingService } from "../tagging/service.ts";
import { fetchCover, origCoverUrl } from "../yandex/media.ts";
import { estimateTrackBytes, HEAVY_TRACK_BYTES, MAX_TRACK_BYTES } from "../yandex/metadata.ts";
import type { TrackMetadata } from "../yandex/types.ts";

const log = getLogger("services.cache");

const mb = (bytes: number): string => `${Math.round(bytes / 1024 ** 2)}мб`;

/** async () → свежая прямая ссылка на mp3 (URL живёт ~1 мин, пере-подписывается). */
export type UrlGetter = () => Promise<string | null>;

/** метаданные трека для кэша: музыкальные поля + кодек/битрейт. */
export type CacheMetadata = TrackMetadata & { codec?: string | null; bitrate_kbps?: number | null };

export interface SentAudio {
  fileId: string;
  messageId: number;
}

export interface SendAudioOpts {
  filename: string;
  title: string;
  performer: string;
  duration: number;
  thumbnail?: Buffer | null;
}

/** канало-привязанная отправка — обёртка над GramIO bot.api. */
export interface TelegramSender {
  sendAudioToChannel(audio: Buffer, opts: SendAudioOpts): Promise<SentAudio>;
  deleteChannelMessage(messageId: number): Promise<void>;
}

export class CacheService {
  private downloadTasks = new Map<string, Promise<string | null>>();
  private payloadTasks = new Map<string, Promise<[Buffer, Buffer | null] | null>>();
  // сериализуем send в канал — иначе на пустышках ловим flood control
  private channelSendLock = new Semaphore(1);
  // тяжёлые треки (>HEAVY_TRACK_BYTES) — строго по одному: иначе N×файл в RAM при 7.8гб
  private heavyLock = new Semaphore(1);

  constructor(
    private sender: TelegramSender,
    private cache: CacheDb,
    private http: HttpClient,
    private tagging: TaggingService,
  ) {}

  get cacheDb(): CacheDb {
    return this.cache;
  }

  async getOrCacheTrack(
    trackId: string,
    artist: string,
    title: string,
    thumbUrl: string | null = null,
    duration = 0,
    album: string | null = null,
    signal?: AbortSignal,
  ): Promise<TrackCacheResult> {
    const filename = getFilename(artist, title);
    const cached = await this.cache.get(trackId);
    if (cached) {
      return { telegram_file_id: cached.telegram_file_id, is_cached: cached.is_cached, filename };
    }
    // inline-окно истекло, пока шёл поиск → не плодим осиротевшую пустышку в канале
    if (signal?.aborted) {
      return { telegram_file_id: "", is_cached: false, filename };
    }
    const fileId = await this.uploadEmptyTrack(trackId, artist, title, album, thumbUrl, duration);
    return { telegram_file_id: fileId, is_cached: false, filename };
  }

  /** полная качка + кэш в канал. дедупит параллельные запросы по (track_id, quality).
   * decrypt — расшифровка скачанных байт (encraw/FLAC), применяется до тегов.
   * quality — тир кэша: 'lossy' (mp3/aac) | 'lossless' (FLAC) | 'nightcore' — разные file_id.
   * transform — перекодировка через -af фильтр (выход mp3); codec тогда = исходный (для декода). */
  async downloadAndCacheTrack(
    trackId: string,
    getUrl: UrlGetter,
    metadata: CacheMetadata | null = null,
    codec = "mp3",
    decrypt?: (data: Buffer) => Buffer,
    quality = "lossy",
    transform?: AudioTransform,
  ): Promise<string | null> {
    const task = this.withDedup(this.downloadTasks, `${trackId}:${quality}`, () =>
      this.downloadAndCacheFullTrack(trackId, getUrl, metadata, codec, decrypt, quality, transform),
    );
    try {
      // таймаут растёт с размером: крупный файл дольше качается, тегируется и льётся в канал
      const estBytes = estimateTrackBytes(metadata?.duration ?? 0, metadata?.bitrate_kbps, codec);
      const timeoutMs = Math.max(600_000, Math.round(estBytes / (2 * 1024 ** 2)) * 1000);
      return await withTimeout(task, timeoutMs);
    } catch (e) {
      log.error(`таймаут/ошибка скачивания ${trackId}: ${e}`);
      return null;
    }
  }

  /** audio+cover+теги. дедуп по (track_id, tier) — lossy и lossless тащатся
   * раздельно. decrypt — расшифровка encraw/FLAC до тегов (для lossless-тира). */
  async prepareTrackPayload(
    trackId: string,
    getUrl: UrlGetter,
    metadata: CacheMetadata,
    codec = "mp3",
    decrypt?: (data: Buffer) => Buffer,
    tier = "lossy",
  ): Promise<[Buffer, Buffer | null] | null> {
    const task = this.withDedup(this.payloadTasks, `${trackId}:${tier}`, () =>
      this.downloadWithMetadata(getUrl, metadata, codec, decrypt),
    );
    try {
      // тот же расчёт таймаута, что и в downloadAndCacheTrack — без него зависший
      // racer в racingDownload (открытый сокет, нет байт, нет своего таймаута)
      // держит альбомный слот юзера вечно: sendAlbumTracks не доходит до finally.
      const estBytes = estimateTrackBytes(metadata.duration ?? 0, metadata.bitrate_kbps, codec);
      const timeoutMs = Math.max(600_000, Math.round(estBytes / (2 * 1024 ** 2)) * 1000);
      const prepared = await withTimeout(task, timeoutMs);
      if (prepared === null) log.error(`трек ${trackId}: не скачался`);
      return prepared;
    } catch (e) {
      log.error(`трек ${trackId}: таймаут/ошибка подготовки: ${e}`);
      return null;
    }
  }

  /** Дедупликация параллельных запросов: если задача с таким ключом уже
   * выполняется — возвращаем ту же Promise; иначе стартуем новую и убираем
   * из map по завершении (успех или ошибка). */
  private withDedup<T>(map: Map<string, Promise<T>>, key: string, factory: () => Promise<T>): Promise<T> {
    const existing = map.get(key);
    if (existing !== undefined) return existing;
    const task = factory();
    map.set(key, task);
    // .finally() возвращает НОВЫЙ promise — если task падает, эта производная
    // тоже падает и повисает необработанной (caller ждёт task, не её), выходя
    // как unhandledRejection и задваивая admin-алерт на каждую упавшую закачку.
    task
      .finally(() => {
        if (map.get(key) === task) map.delete(key);
      })
      .catch(() => {});
    return task;
  }

  private async uploadEmptyTrack(
    trackId: string,
    artist: string,
    title: string,
    album: string | null,
    thumbUrl: string | null,
    duration: number | null,
  ): Promise<string> {
    const emptyMp3 = createEmptyMp3(artist, title, album);
    const filename = getFilename(artist, title);

    return this.channelSendLock.run(async () => {
      // перепроверяем — пока ждали семафор, параллельный запрос мог создать пустышку
      const cached = await this.cache.get(trackId);
      if (cached) return cached.telegram_file_id;

      const sent = await this.sender.sendAudioToChannel(emptyMp3, {
        filename,
        title,
        performer: artist,
        duration: 1,
      });
      await this.cache.save(trackId, sent.fileId, false, {
        telegram_message_id: sent.messageId,
        has_metadata: false,
        artist,
        title,
        album,
        cover_url: thumbUrl,
        duration,
      });
      return sent.fileId;
    });
  }

  /** заливает в канал, обновляет БД, возвращает file_id (для MediaGroup-сценария). */
  async uploadToChannel(
    trackId: string,
    audioWithMetadata: Buffer,
    coverData: Buffer | null,
    metadata: CacheMetadata,
    codec = "mp3",
    quality = "lossy",
  ): Promise<string | null> {
    try {
      const sent = await this.channelSendLock.run(() => this.sendAudio(audioWithMetadata, coverData, metadata, codec));
      await this.persistCached(trackId, sent.fileId, sent.messageId, metadata, true, quality);
      log.debug(`трек ${trackId} залит в канал`);
      return sent.fileId;
    } catch (e) {
      log.warning(`ошибка заливки ${trackId} в канал: ${e}`);
      return null;
    }
  }

  /** пишет полный metadata в БД; при апгрейде stub→full удаляет старую пустышку. */
  private async persistCached(
    trackId: string,
    fileId: string,
    messageId: number | null,
    m: CacheMetadata,
    isCached: boolean,
    quality = "lossy",
  ): Promise<void> {
    let oldStubMsgId: number | null = null;
    // uploadEmptyTrack всегда кладёт пустышку в tier 'lossy' независимо от того,
    // в каком tier'е закончится реальная заливка — при апгрейде lossless-трека
    // ищем пустышку не в 'lossless', а там, где она реально лежит.
    const stubTier = quality === "lossy" ? quality : "lossy";
    const crossTier = stubTier !== quality;
    if (isCached) {
      const old = await this.cache.get(trackId, stubTier);
      if (old && !old.is_cached && old.telegram_message_id && old.telegram_message_id !== messageId) {
        oldStubMsgId = old.telegram_message_id;
      }
    }

    await this.cache.save(
      trackId,
      fileId,
      isCached,
      {
        telegram_message_id: messageId,
        has_metadata: isCached,
        artist: m.artist || "",
        title: m.title || "",
        album: m.album || "",
        cover_url: m.cover_url || "",
        duration: m.duration || 0,
        year: String(m.year || "") || null,
        label: m.label || null,
        genre: m.genre || null,
        codec: m.codec || null,
        bitrate_kbps: m.bitrate_kbps || null,
      },
      quality,
    );

    if (oldStubMsgId !== null && crossTier) {
      // save() выше писал в другой tier — строка пустышки в stubTier'е сама себя
      // не перезаписала, останется указывать на снесённое сообщение. Удаляем
      // строку целиком: следующий getOrCacheTrack() честно заведёт свежую пустышку.
      void this.cache.deleteStubRow(trackId, stubTier).catch((e) => {
        log.debug(`не вышло удалить строку-пустышку tier=${stubTier}: ${e}`);
      });
    }

    if (oldStubMsgId !== null) {
      void this.sender.deleteChannelMessage(oldStubMsgId).catch((e) => {
        log.debug(`не вышло удалить пустышку msg=${oldStubMsgId}: ${e}`);
      });
    }
  }

  /** audio (racing+retry) и cover параллельно, теги поверх. */
  private async downloadWithMetadata(
    getUrl: UrlGetter,
    metadata: CacheMetadata,
    codec = "mp3",
    decrypt?: (data: Buffer) => Buffer,
    transform?: AudioTransform,
  ): Promise<[Buffer, Buffer | null] | null> {
    // preflight: оценка размера ДО скачивания. Двойной буфер (качка+теги) в RAM при
    // 7.8гб всего → большой файл = OOM-kill. Отказываем заранее, не тратя трафик.
    const estBytes = estimateTrackBytes(metadata.duration, metadata.bitrate_kbps, codec);
    if (estBytes > MAX_TRACK_BYTES) {
      log.warning(`трек ~${mb(estBytes)} > лимит ${mb(MAX_TRACK_BYTES)} — пропуск (защита RAM), не качаю`);
      return null;
    }
    // тяжёлый → строго по одному (heavyLock) + одиночная качка без racing-параллелизма
    const heavy = estBytes > HEAVY_TRACK_BYTES;
    if (heavy) return this.heavyLock.run(() => this.fetchAndTag(getUrl, metadata, codec, decrypt, transform, true));
    return this.fetchAndTag(getUrl, metadata, codec, decrypt, transform, false);
  }

  private async fetchAndTag(
    getUrl: UrlGetter,
    metadata: CacheMetadata,
    codec: string,
    decrypt: ((data: Buffer) => Buffer) | undefined,
    transform: AudioTransform | undefined,
    solo: boolean,
  ): Promise<[Buffer, Buffer | null] | null> {
    // thumbData — мелкая обложка для миниатюры Telegram (как cover_url, ~400x400);
    // embedData — /orig для вшивания в файл. На сбой orig фолбэк на thumb.
    let thumbData = metadata.cover_data;
    let embedData = metadata.cover_data;
    const coverUrl = metadata.cover_url || "";
    // solo: одиночная качка (тяжёлый трек) вместо racing — иначе до 3× файла в RAM
    const fetchAudio = (): Promise<Buffer | null> =>
      solo ? this.soloDownload(getUrl) : this.racingDownloadWithRetry(getUrl);

    let audioData: Buffer | null;
    if (thumbData === null && coverUrl) {
      const origUrl = origCoverUrl(coverUrl);
      const [audio, thumb, orig] = await Promise.all([
        fetchAudio(),
        fetchCover(coverUrl, this.http),
        origUrl && origUrl !== coverUrl ? fetchCover(origUrl, this.http) : Promise.resolve(null),
      ]);
      audioData = audio;
      thumbData = thumb;
      embedData = orig ?? thumb;
    } else {
      audioData = await fetchAudio();
    }

    if (audioData === null) return null;
    // post-download точный гейт: оценка по битрейту могла занизить
    if (audioData.length > MAX_TRACK_BYTES) {
      log.warning(`трек по факту ${mb(audioData.length)} > лимит — отказ до тегов/заливки`);
      return null;
    }
    if (decrypt) audioData = decrypt(audioData); // encraw → расшифровка до тегов

    const audioWithMetadata = await this.tagging.addMetadata(
      audioData,
      { ...metadata, cover_data: embedData },
      codec,
      transform,
    );
    return [audioWithMetadata, thumbData];
  }

  /** одиночная качка с последовательными ретраями — для тяжёлых треков (без racing-параллелизма). */
  private async soloDownload(getUrl: UrlGetter): Promise<Buffer | null> {
    const url = await getUrl();
    if (!url) return null;
    try {
      return await this.http.downloadAudio(url, 3);
    } catch (e) {
      log.warning(`[solo] качка большого трека не вышла: ${e}`);
      return null;
    }
  }

  private async sendAudio(
    audioWithMetadata: Buffer,
    coverData: Buffer | null,
    m: CacheMetadata,
    codec = "mp3",
  ): Promise<SentAudio> {
    const artist = m.artist || "";
    const title = m.title || "";
    return this.sender.sendAudioToChannel(audioWithMetadata, {
      filename: getFilename(artist, title, codec),
      title,
      performer: artist,
      duration: m.duration || 0,
      thumbnail: coverData,
    });
  }

  /** несколько волн racing — узлы CDN иногда «отходят» за 2-3с. */
  private async racingDownloadWithRetry(getUrl: UrlGetter, waves = 2, wavePauseMs = 3_000): Promise<Buffer | null> {
    for (let wave = 1; wave <= waves; wave++) {
      const data = await this.racingDownload(getUrl);
      if (data !== null) return data;
      if (wave < waves) {
        log.info(`[racing] волна ${wave} проиграла, повтор через ${wavePauseMs / 1000}с`);
        await sleep(wavePauseMs);
      }
    }
    return null;
  }

  /** параллельные попытки со staggered стартом, первая успешная — победитель.
   * CDN яндекса часто виснет на одном узле но отвечает с другого. staggerMs
   * снижен вслед за AUDIO_CONNECT_TIMEOUT (см. http.ts) — при зависшем узле
   * бэкап должен стартовать заметно раньше его 4с таймаута, не после него. */
  private async racingDownload(getUrl: UrlGetter, maxAttempts = 3, staggerMs = 2_500): Promise<Buffer | null> {
    let resolved = false;
    let winner: Buffer | null = null;
    let failedCount = 0;
    const controllers: AbortController[] = [];
    let doneResolve!: () => void;
    const done = new Promise<void>((r) => {
      doneResolve = r;
    });
    const finish = () => {
      if (!resolved) {
        resolved = true;
        doneResolve();
      }
    };

    const attempt = async (n: number): Promise<void> => {
      const ctrl = new AbortController();
      controllers.push(ctrl);
      try {
        const url = await getUrl();
        if (!url) {
          if (++failedCount >= maxAttempts) finish();
          return;
        }
        const data = await this.http.downloadAudio(url, 1, ctrl.signal);
        if (!resolved) {
          winner = data;
          finish();
          log.info(`[racing] попытка ${n} победила`);
        }
      } catch (e) {
        if (ctrl.signal.aborted) return;
        log.debug(`[racing] попытка ${n} не вышла: ${e}`);
        if (++failedCount >= maxAttempts) finish();
      }
    };

    const tasks: Promise<void>[] = [];
    for (let i = 0; i < maxAttempts; i++) {
      tasks.push(attempt(i + 1));
      if (resolved) break;
      if (i < maxAttempts - 1) {
        const raced = await Promise.race([sleep(staggerMs).then(() => "timeout"), done.then(() => "done")]);
        if (raced === "done") break;
      }
    }
    if (!resolved) await done;
    for (const c of controllers) c.abort();
    await Promise.allSettled(tasks);
    return winner;
  }

  private async downloadAndCacheFullTrack(
    trackId: string,
    getUrl: UrlGetter,
    metadata: CacheMetadata | null,
    codec = "mp3",
    decrypt?: (data: Buffer) => Buffer,
    quality = "lossy",
    transform?: AudioTransform,
  ): Promise<string | null> {
    let meta = metadata;
    if (meta === null) {
      const cached = await this.cache.get(trackId, quality);
      if (!cached) {
        log.error(`трек ${trackId} не найден в БД`);
        return null;
      }
      meta = {
        artist: cached.artist || "",
        title: cached.title || "",
        album: cached.album || "",
        album_artist: cached.artist || "",
        year: cached.year || "",
        label: cached.label || "",
        genre: cached.genre,
        composer: null,
        version: null,
        explicit: false,
        duration: cached.duration || 0,
        track_number: null,
        track_total: null,
        disc_number: null,
        disc_total: null,
        cover_url: cached.cover_url || "",
        cover_data: null,
      };
    }

    const prepared = await this.downloadWithMetadata(getUrl, meta, codec, decrypt, transform);
    if (prepared === null) {
      log.error(`трек ${trackId}: не скачался`);
      return null;
    }
    const [audioWithMetadata, coverData] = prepared;

    // при transform аудио перекодировано в mp3 — отдаём/кэшируем под mp3, не исходным кодеком.
    const outCodec = transform ? "mp3" : codec;
    const sent = await this.channelSendLock.run(() => this.sendAudio(audioWithMetadata, coverData, meta!, outCodec));
    if (!sent.fileId) {
      log.error(`трек ${trackId}: канал не вернул file_id — не кэширую`); // иначе is_cached=true с пустым file_id отравит кэш навсегда
      return null;
    }
    await this.persistCached(trackId, sent.fileId, sent.messageId, meta, true, quality);
    return sent.fileId;
  }
}
