/** Раз в час перезаливает пустышки старше 24ч в кэш-канал.
 *
 * Зависимости инъекцией: берём список протухших из cacheDb, ходим за CDN
 * под токеном любого живого юзера. */

import { createInterruptibleSleep } from "../infra/async.ts";
import { getLogger } from "../infra/logging.ts";
import type { CacheDb } from "../storage/cache.ts";
import type { UsersDb } from "../storage/users.ts";
import type { YandexClient } from "../yandex/client.ts";
import { buildTrackMetadata, enrichMetadataFromAlbum, trackIsTooLong } from "../yandex/metadata.ts";
import type { CacheMetadata, CacheService } from "./cache.ts";

const log = getLogger("services.stale");

const MAX_TOKEN_CANDIDATES = 5;

export interface StaleDeps {
  cacheDb: CacheDb;
  usersDb: UsersDb;
  cacheService: CacheService;
  /** расшифровать/обновить токен юзера. */
  resolveToken: (userId: number) => Promise<string | null>;
  /** получить YandexClient под токеном. */
  getYandexClient: (token: string, userId: number) => Promise<YandexClient>;
}

export class StaleRefresher {
  private stopped = false;
  private runPromise: Promise<void> | null = null;
  // будит спящий interval досрочно при stop() — иначе shutdown ждёт весь час.
  private readonly sleeper = createInterruptibleSleep();

  private deps: StaleDeps;
  // R7: потолок перекачек за прогон (STALE_REFRESH_LIMIT); 0 — фоновая задача выключена
  private readonly limit: number;

  constructor(deps: StaleDeps, limit = 50) {
    this.deps = deps;
    this.limit = Math.max(0, limit);
  }

  start(intervalMs = 3_600_000): void {
    if (this.runPromise !== null) return;
    if (this.limit === 0) {
      log.info("[stale] выключен (STALE_REFRESH_LIMIT=0)");
      return;
    }
    this.stopped = false;
    this.runPromise = this.runForever(intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.sleeper.wake();
    if (this.runPromise) await this.runPromise.catch(() => {});
    this.runPromise = null;
  }

  private async runForever(intervalMs: number): Promise<void> {
    while (!this.stopped) {
      await this.sleeper.sleep(intervalMs);
      if (this.stopped) break;
      try {
        await this.refreshOnce();
      } catch (e) {
        log.error(`[stale] ошибка: ${e}`);
      }
    }
  }

  async refreshOnce(): Promise<void> {
    if (this.limit === 0) return;
    log.info("[stale] проверка устаревших...");
    const stale = await this.deps.cacheDb.getStaleUncached(24, this.limit);
    if (stale.length === 0) {
      log.info("[stale] устаревших нет");
      return;
    }
    log.info(`[stale] нашёл ${stale.length} треков`);

    // за CDN ходим под токеном любого живого юзера: пробуем ограниченное число
    // кандидатов (свежие первыми), мёртвый/нерасшифровываемый токен не валит прогон
    const candidates = await this.deps.usersDb.candidateUserIds(MAX_TOKEN_CANDIDATES);
    if (candidates.length === 0) {
      log.warning("[stale] нет доступных токенов");
      return;
    }
    let yandex: YandexClient | null = null;
    for (const userId of candidates) {
      try {
        const token = await this.deps.resolveToken(userId);
        if (!token) {
          log.warning(`[stale] токен юзера ${userId} недоступен, пробую следующего`);
          continue;
        }
        yandex = await this.deps.getYandexClient(token, userId);
        break;
      } catch (e) {
        log.warning(
          `[stale] юзер ${userId}: токен не подошёл (${e instanceof Error ? e.name : "error"}), пробую следующего`,
        );
      }
    }
    if (yandex === null) {
      log.warning(`[stale] ни один из ${candidates.length} кандидатов не дал рабочий токен — прогон пропущен`);
      return;
    }
    let refreshed = 0;

    for (const entry of stale) {
      if (this.stopped) break; // shutdown — не начинаем ещё один тяжёлый докачивание
      const trackId = entry.track_id;
      const quality = entry.quality;
      try {
        const track = await yandex.getTrackById(Number(trackId));
        if (!track) {
          await this.deps.cacheDb.touchStale(trackId, quality);
          continue;
        }
        if (trackIsTooLong(track)) {
          log.debug(`[stale] трек ${trackId} длинный — пропуск`);
          await this.deps.cacheDb.touchStale(trackId, quality);
          continue;
        }
        let metadata: CacheMetadata = buildTrackMetadata(track);
        metadata = (await enrichMetadataFromAlbum(metadata, track, yandex)) as CacheMetadata;
        const info = await yandex.getBestDownloadInfo(track);
        if (info === null) {
          await this.deps.cacheDb.touchStale(trackId, quality);
          continue;
        }
        metadata.codec = info.codec;
        metadata.bitrate_kbps = info.bitrateInKbps;
        // directLinkFromInfo(info), а не getDownloadUrl(track) — второй сам
        // внутри заново дёргает getBestDownloadInfo, т.е. до 4х round-trip'ов
        // за download-info на один трек вместо одного (см. albums.ts — там уже так).
        const fileId = await this.deps.cacheService.downloadAndCacheTrack(
          trackId,
          () => yandex.directLinkFromInfo(info),
          metadata,
          info.codec,
          quality,
        );
        if (fileId === null) {
          await this.deps.cacheDb.touchStale(trackId, quality);
          continue;
        }
        refreshed++;
      } catch (e) {
        log.warning(`[stale] ошибка трек ${trackId}: ${e}`);
        await this.deps.cacheDb.touchStale(trackId, quality).catch(() => {});
      }
    }
    log.info(`[stale] перезалито ${refreshed}/${stale.length}`);
  }
}
