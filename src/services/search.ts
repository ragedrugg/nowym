/** Поиск треков/альбомов → inline-результаты GramIO.
 *
 * Кэширует Track-объекты в LRU (повторный выбор не дёргает api заново) и готовые
 * наборы результатов в TTLCache. */
import { format, bold, italic, InlineQueryResult, InputMessageContent } from "gramio";
import { getLogger } from "../infra/logging.ts";
import type { TTLCache } from "../infra/memoryCache.ts";
import { parseSearchQuery } from "../infra/parsers.ts";
import { sleep } from "../infra/async.ts";
import { LRUMap } from "../infra/lruMap.ts";
import { formatArtists } from "../yandex/metadata.ts";
import { normalizeCoverUrl } from "../yandex/media.ts";
import { albumUrl } from "../yandex/urls.ts";
import type { YandexClient } from "../yandex/client.ts";
import type { YaAlbum, YaTrack } from "../yandex/types.ts";
import type { CacheService } from "./cache.ts";
import { buildTrackCaption } from "../bot/captions.ts";
import {
  loadingMarkup,
  progressMarkup,
  trackMarkup,
} from "../bot/markup.ts";

const log = getLogger("services.search");

const TRACK_LRU_MAX = 200;
// пул истории для пагинируемого «недавнего» в inline — фетчим раз и листаем из него.
const RECENT_POOL_SIZE = 48;
const RECENT_POOL_TTL_MS = 120_000;

export type InlineResult =
  | ReturnType<typeof InlineQueryResult.article>
  | ReturnType<typeof InlineQueryResult.audio>
  | ReturnType<typeof InlineQueryResult.cached.audio>;

interface TrackMeta {
  artistNames: string;
  duration: number;
  thumbUrl: string;
  albumName: string;
}

export class SearchService {
  private trackObjects = new LRUMap<string, YaTrack>(TRACK_LRU_MAX);
  // короткоживущий кэш пула истории — чтобы листание inline-«недавнего» не дёргало API.
  private recentPool: { tracks: YaTrack[]; at: number } | null = null;

  constructor(
    public yandexService: YandexClient,
    private resultsCache: TTLCache<InlineResult[]>,
    private cacheService: CacheService | null,
    private botUsername: string | null,
    // resultsCache — container.trackCache, общий на всех пользователей (SearchService
    // хоть и per-user, кэш инжектится один и тот же). "недавнее" — приватная история
    // прослушиваний, без соли userId юзер B словил бы кэш юзера A по тому же ключу.
    private userId: number | null = null,
  ) {}

  cacheTrackObject(track: YaTrack): void {
    this.trackObjects.set(String(track.id), track);
  }

  getTrackObject(trackId: string): YaTrack | null {
    return this.trackObjects.get(trackId) ?? null;
  }

  private getTrackMeta(track: YaTrack): TrackMeta {
    const duration = track.durationMs ? Math.floor(track.durationMs / 1000) : 0;
    const album = track.albums && track.albums.length > 0 ? track.albums[0]! : null;
    return {
      artistNames: formatArtists(track.artists),
      duration,
      thumbUrl: normalizeCoverUrl(track.coverUri || ""),
      albumName: album?.title || "",
    };
  }

  async createInlineResultFromTrack(track: YaTrack, layout = "button", sendMode = "text_media", signal?: AbortSignal): Promise<InlineResult | null> {
    this.cacheTrackObject(track);
    const meta = this.getTrackMeta(track);
    if (sendMode === "text_media") {
      // даже в режиме «текст → медиа»: если трек УЖЕ в кэше — сразу отдаём
      // аудио (не текст-пустышку), без аплоада. Текст-плейсхолдер остаётся
      // только для незакэшированных — там аплоад ленив, на chosen.
      if (this.cacheService) {
        const cached = await this.cacheService.cacheDb.get(String(track.id));
        if (cached && cached.is_cached) {
          return this.buildCachedAudioResult(
            String(track.id), cached.telegram_file_id, true, layout, cached.codec, cached.bitrate_kbps,
          );
        }
      }
      return this.createTextMediaResult(track, meta);
    }
    if (this.cacheService) return this.createCachedResult(track, meta, layout, signal);
    return this.createFallbackResult(track, meta);
  }

  /** Article «гружу X — Y», на choose заменяется на аудио через editMessageMedia. */
  private createTextMediaResult(track: YaTrack, meta: TrackMeta): InlineResult {
    const trackId = String(track.id);
    const artist = meta.artistNames;
    const title = (track.title || "").trim() || "—";
    const head = artist ? `${artist} — ${title}` : title;
    return InlineQueryResult.article(`tm:${trackId}`, `⬇️ ${head}`, InputMessageContent.text(format`гружу ${bold(head)}`, { link_preview_options: { is_disabled: true } }), {
      description: "нажми — заменю текст на трек",
      ...(meta.thumbUrl ? { thumbnail_url: meta.thumbUrl } : {}),
      // без reply_markup tg не отдаёт inline_message_id в chosen_inline_result
      reply_markup: progressMarkup(trackId, "качаю..."),
    });
  }

  private async createFallbackResult(track: YaTrack, meta: TrackMeta): Promise<InlineResult> {
    const audioUrl = await this.yandexService.getDownloadUrl(track);
    if (!audioUrl) throw new Error("нет вариантов скачивания для трека");
    return InlineQueryResult.audio(String(track.id), audioUrl, track.title || "—", {
      performer: meta.artistNames,
      audio_duration: meta.duration,
    });
  }

  private async createCachedResult(track: YaTrack, meta: TrackMeta, layout: string, signal?: AbortSignal): Promise<InlineResult> {
    const trackId = String(track.id);
    const cached = await this.cacheService!.cacheDb.get(trackId);
    const isCachedNow = Boolean(cached && cached.is_cached);
    const codec = isCachedNow ? (cached?.codec ?? null) : null;
    const bitrate = isCachedNow ? (cached?.bitrate_kbps ?? null) : null;

    let fileId: string;
    let cachedFlag = isCachedNow;
    if (cached) {
      fileId = cached.telegram_file_id;
    } else {
      const info = await this.cacheService!.getOrCacheTrack(
        trackId,
        meta.artistNames,
        track.title || "—",
        meta.thumbUrl,
        meta.duration,
        meta.albumName,
        signal,
      );
      fileId = info.telegram_file_id;
      cachedFlag = info.is_cached;
    }
    return this.buildCachedAudioResult(trackId, fileId, cachedFlag, layout, codec, bitrate);
  }

  private buildCachedAudioResult(
    trackId: string, fileId: string, isCached: boolean, layout: string,
    codec: string | null, bitrateKbps: number | null,
  ): InlineResult {
    if (isCached) {
      if (layout === "none") return InlineQueryResult.cached.audio(trackId, fileId);
      if (layout === "text") return InlineQueryResult.cached.audio(trackId, fileId, { caption: buildTrackCaption(trackId, codec, bitrateKbps) });
      if (layout === "both")
        return InlineQueryResult.cached.audio(trackId, fileId, { caption: buildTrackCaption(trackId, codec, bitrateKbps), reply_markup: trackMarkup(trackId, true) });
      return InlineQueryResult.cached.audio(trackId, fileId, { reply_markup: trackMarkup(trackId, true) });
    }
    // пустышка — кнопка нужна всегда (юзер видит прогресс)
    return InlineQueryResult.cached.audio(trackId, fileId, { reply_markup: loadingMarkup(trackId) });
  }

  private async allAlreadyCached(trackIds: (string | number)[]): Promise<boolean> {
    if (!this.cacheService) return false;
    const rows = await Promise.all(trackIds.map((id) => this.cacheService!.cacheDb.get(id)));
    return rows.every((r) => r?.is_cached === true);
  }

  private createAlbumResult(album: YaAlbum): InlineResult | null {
    if (!this.botUsername) return null;
    const albumId = album.id;
    if (albumId === undefined || albumId === null) return null;
    const title = album.title || "Без названия";
    const artistNames = formatArtists(album.artists);
    const trackCount = album.trackCount || 0;
    const year = album.year || "";
    const thumbUrl = normalizeCoverUrl(album.coverUri || "", "200x200");

    const suffixParts: string[] = [];
    if (year) suffixParts.push(String(year));
    if (trackCount) suffixParts.push(`${trackCount} треков`);
    const suffix = suffixParts.join(", ");

    const head = `${artistNames} — ${title}`;
    const albumLink = albumUrl(albumId);
    const text = suffix
      ? format`📀 ${bold(head)}\n${italic(suffix)}\n\n${albumLink}`
      : format`📀 ${bold(head)}\n\n${albumLink}`;

    const deepLink = `https://t.me/${this.botUsername}?start=album_${albumId}`;
    return InlineQueryResult.article(`album:${albumId}`, `📀 ${title}`, InputMessageContent.text(text), {
      description: artistNames + (suffix ? `, ${suffix}` : ""),
      ...(thumbUrl ? { thumbnail_url: thumbUrl } : {}),
      reply_markup: { inline_keyboard: [[{ text: "выгрузить альбом мне в личку", url: deepLink }]] },
    });
  }

  async searchAndCreateResults(query: string, maxResults = 5, layout = "button", sendMode = "text_media", signal?: AbortSignal, tracksOnly = false): Promise<InlineResult[]> {
    try {
      const cacheKey = `search:${layout}:${sendMode}:${tracksOnly ? "t:" : ""}${query}:${maxResults}`;
      const cachedRes = this.resultsCache.get(cacheKey);
      if (cachedRes) {
        log.debug(`кэш HIT: ${JSON.stringify(query)}`);
        return cachedRes;
      }

      const parsed = parseSearchQuery(query);
      let results: InlineResult[] = [];
      // id треков, чей результат мог получить СВЕЖИЙ стаб-file_id (а не реальный
      // кэш) — если такой есть, массив results не кэшируем: 300с TTL иначе ещё
      // долго отдавал бы тишину даже после того, как реальная загрузка завершится.
      let trackIdsInResult: (string | number)[] = [];

      if (parsed.type === "track_link") {
        const track = await this.yandexService.getTrackById(parsed.track_id);
        if (track) {
          const r = await this.safeCreateTrack(track, layout, sendMode, signal);
          if (r) { results.push(r); trackIdsInResult.push(parsed.track_id); }
        }
      } else if (parsed.type === "album_link") {
        const album = await this.yandexService.getAlbumShort(parsed.album_id);
        if (album) {
          const r = this.createAlbumResult(album);
          if (r) results.push(r);
        }
      } else if (parsed.type === "search") {
        // tracksOnly — для поиска по строке лирики (" ...): нужен только трек,
        // альбомы тут шум.
        const [tracks, albums] = await Promise.all([
          this.yandexService.searchTracks(query, maxResults),
          tracksOnly ? Promise.resolve([] as YaAlbum[]) : this.yandexService.searchAlbums(query, 2),
        ]);
        const trackResults = tracks.length > 0 ? await this.createTrackResultsParallel(tracks, layout, sendMode, signal) : [];
        const albumResults = albums.map((a) => this.createAlbumResult(a)).filter((r): r is InlineResult => r !== null);
        results = [...trackResults, ...albumResults]; // альбомы вторым блоком
        trackIdsInResult = tracks.map((t) => t.id!);
      } else if (parsed.type === "empty") {
        const current = await this.yandexService.getCurrentTrack();
        if (current.track) {
          const r = await this.safeCreateTrack(current.track, layout, sendMode, signal);
          if (r) results.push(r);
        }
      }

      if (results.length > 0 && parsed.type !== "empty" && this.cacheService && !signal?.aborted) {
        const cacheable = trackIdsInResult.length === 0 || (await this.allAlreadyCached(trackIdsInResult));
        if (cacheable) this.resultsCache.set(cacheKey, results, 300);
      }
      log.debug(`создано ${results.length} результатов: ${JSON.stringify(query)}`);
      return results;
    } catch (e) {
      log.error(`ошибка поиска ${JSON.stringify(query)}: ${e}`);
      return [];
    }
  }

  /** пагинированный поиск треков для inline. offset = "ypage:within"
   * (ypage — страница Яндекса, within — сдвиг внутри неё). Возвращает окно
   * результатов + next_offset ("" = конец). Дорогой шаг (аплоад пустышек) —
   * только для текущего окна; страница Яндекса дешева, фетчим её каждый раз
   * (нужна для расчёта next_offset), а собранное окно кэшируем. */
  async searchTracksPaged(
    query: string,
    offset: string,
    pageSize: number,
    layout: string,
    sendMode: string,
    signal?: AbortSignal,
  ): Promise<{ results: InlineResult[]; nextOffset: string }> {
    const [ypageStr, withinStr] = offset.split(":");
    const ypage = Math.max(0, parseInt(ypageStr || "0", 10) || 0);
    const within = Math.max(0, parseInt(withinStr || "0", 10) || 0);

    const { tracks, total, perPage } = await this.yandexService.searchTracksPage(query, ypage);
    const slice = tracks.slice(within, within + pageSize);

    const cacheKey = `paged:${layout}:${sendMode}:${query}:${ypage}:${within}:${pageSize}`;
    let results = this.resultsCache.get(cacheKey);
    if (!results) {
      results = slice.length > 0 ? await this.createTrackResultsParallel(slice, layout, sendMode, signal) : [];
      if (results.length > 0 && this.cacheService && !signal?.aborted) {
        const cacheable = await this.allAlreadyCached(slice.map((t) => t.id!));
        if (cacheable) this.resultsCache.set(cacheKey, results, 300);
      }
    }

    const nextWithin = within + pageSize;
    let nextOffset = "";
    if (nextWithin < tracks.length) {
      nextOffset = `${ypage}:${nextWithin}`;
    } else if (perPage > 0 && (ypage + 1) * perPage < total) {
      nextOffset = `${ypage + 1}:0`;
    }
    return { results, nextOffset };
  }

  /** пул недавнего (история) с коротким кэшем — листание не дёргает API каждую страницу. */
  private async getRecentPool(): Promise<YaTrack[]> {
    const now = Date.now();
    if (this.recentPool && now - this.recentPool.at < RECENT_POOL_TTL_MS) return this.recentPool.tracks;
    const tracks = await this.yandexService.getRecentTracks(RECENT_POOL_SIZE);
    this.recentPool = { tracks, at: now };
    return tracks;
  }

  /** недавнее с пагинацией для inline. offset = "within" (целое смещение в пуле).
   * Возвращает окно результатов + next_offset ("" = конец). Окна кэшируются. */
  async recentResultsPaged(
    offset: string,
    pageSize: number,
    layout: string,
    sendMode: string,
    signal?: AbortSignal,
  ): Promise<{ results: InlineResult[]; nextOffset: string }> {
    const within = Math.max(0, parseInt(offset || "0", 10) || 0);
    const pool = await this.getRecentPool();
    const slice = pool.slice(within, within + pageSize);

    const cacheKey = `recent:${this.userId ?? "anon"}:${layout}:${sendMode}:${within}:${pageSize}`;
    let results = this.resultsCache.get(cacheKey);
    if (!results) {
      results = slice.length > 0 ? await this.createTrackResultsParallel(slice, layout, sendMode, signal) : [];
      if (results.length > 0 && this.cacheService && !signal?.aborted) {
        const cacheable = await this.allAlreadyCached(slice.map((t) => t.id!));
        if (cacheable) this.resultsCache.set(cacheKey, results, 120);
      }
    }

    const nextWithin = within + pageSize;
    const nextOffset = nextWithin < pool.length ? String(nextWithin) : "";
    return { results, nextOffset };
  }

  private async createTrackResultsParallel(tracks: YaTrack[], layout: string, sendMode: string, signal?: AbortSignal): Promise<InlineResult[]> {
    // 6с — запас на 1-2 send_audio (создание пустышек); inline window ~10с
    const out: (InlineResult | null)[] = new Array(tracks.length).fill(null);
    // локальная отмена: гонка истекла / внешний таймаут → проигравшие задачи
    // бросают работу до аплоада пустышки, чтобы не было осиротевших send_audio
    const localAc = new AbortController();
    if (signal) {
      if (signal.aborted) localAc.abort();
      else signal.addEventListener("abort", () => localAc.abort(), { once: true });
    }
    const tasks = tracks.map((t, i) =>
      this.safeCreateTrack(t, layout, sendMode, localAc.signal).then((r) => {
        out[i] = r;
      }),
    );
    await Promise.race([Promise.allSettled(tasks), sleep(6000)]);
    localAc.abort();
    return out.filter((r): r is InlineResult => r !== null);
  }

  private async safeCreateTrack(track: YaTrack, layout: string, sendMode: string, signal?: AbortSignal): Promise<InlineResult | null> {
    if (signal?.aborted) return null;
    try {
      const r = await this.createInlineResultFromTrack(track, layout, sendMode, signal);
      // отменили на полпути (аплоад пустышки пропущен → fileId пустой) — отбрасываем
      return signal?.aborted ? null : r;
    } catch (e) {
      log.warning(`не вышло сделать результат для трека ${track.id}: ${e}`);
      return null;
    }
  }
}
