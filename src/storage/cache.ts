/** БД кэша треков (telegram_cache UNLOGGED) + in-flight альбомы (LOGGED). */
import { cachePool } from "./pool.ts";
import type { CachedTrack, InflightAlbum } from "./types.ts";

export interface SaveTrackOptions {
  artist?: string | null;
  title?: string | null;
  album?: string | null;
  cover_url?: string | null;
  telegram_message_id?: number | null;
  duration?: number | null;
  has_metadata?: boolean;
  year?: string | null;
  label?: string | null;
  genre?: string | null;
  codec?: string | null;
  bitrate_kbps?: number | null;
}

const SELECT_COLS =
  "track_id, telegram_file_id, telegram_message_id, is_cached, has_metadata, " +
  "artist, title, album, cover_url, duration, year, label, genre, codec, bitrate_kbps";

export function rowToCachedTrack(r: Record<string, unknown>): CachedTrack {
  return {
    track_id: String(r.track_id),
    telegram_file_id: (r.telegram_file_id as string) ?? "",
    telegram_message_id: (r.telegram_message_id as number | null) ?? null,
    is_cached: Boolean(r.is_cached),
    has_metadata: Boolean(r.has_metadata),
    artist: (r.artist as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    album: (r.album as string | null) ?? null,
    cover_url: (r.cover_url as string | null) ?? null,
    duration: (r.duration as number | null) ?? null,
    year: (r.year as string | null) ?? null,
    label: (r.label as string | null) ?? null,
    genre: (r.genre as string | null) ?? null,
    codec: (r.codec as string | null) ?? null,
    bitrate_kbps: (r.bitrate_kbps as number | null) ?? null,
  };
}

export class CacheDb {
  async initSchema(): Promise<void> {
    // UNLOGGED — кэш файлов, можем потерять при crash postgres, не критично
    await cachePool.query(`
      CREATE UNLOGGED TABLE IF NOT EXISTS telegram_cache (
        track_id             BIGINT       PRIMARY KEY,
        telegram_file_id     TEXT         NOT NULL,
        telegram_message_id  BIGINT,
        is_cached            BOOLEAN      NOT NULL DEFAULT FALSE,
        has_metadata         BOOLEAN      NOT NULL DEFAULT FALSE,
        artist               TEXT,
        title                TEXT,
        album                TEXT,
        cover_url            TEXT,
        duration             INTEGER,
        year                 TEXT,
        label                TEXT,
        genre                TEXT,
        codec                TEXT,
        bitrate_kbps         INTEGER,
        created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      ) WITH (fillfactor = 85)
    `);
    await cachePool.query("ALTER TABLE telegram_cache ADD COLUMN IF NOT EXISTS codec TEXT");
    await cachePool.query("ALTER TABLE telegram_cache ADD COLUMN IF NOT EXISTS bitrate_kbps INTEGER");
    // тир качества в ключе: 'lossy' (mp3/aac) и 'lossless' (FLAC) — разные file_id
    // одного трека. Существующие строки → 'lossy'. PK расширяем до (track_id, quality).
    await cachePool.query("ALTER TABLE telegram_cache ADD COLUMN IF NOT EXISTS quality TEXT NOT NULL DEFAULT 'lossy'");
    await cachePool.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'telegram_cache_pkey' AND array_length(conkey, 1) = 1
        ) THEN
          ALTER TABLE telegram_cache DROP CONSTRAINT telegram_cache_pkey;
          ALTER TABLE telegram_cache ADD PRIMARY KEY (track_id, quality);
        END IF;
      END $$
    `);
    await cachePool.query(
      "CREATE INDEX IF NOT EXISTS idx_telegram_cache_stale ON telegram_cache (updated_at) WHERE is_cached = FALSE",
    );
    // LOGGED — нужно пережить рестарт бота, чтобы resume_inflight подхватил
    await cachePool.query(`
      CREATE TABLE IF NOT EXISTS album_inflight (
        id                  BIGSERIAL    PRIMARY KEY,
        user_id             BIGINT       NOT NULL,
        chat_id             BIGINT       NOT NULL,
        album_id            BIGINT       NOT NULL,
        progress_message_id BIGINT,
        completed_track_ids BIGINT[]     NOT NULL DEFAULT '{}',
        started_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await cachePool.query(
      "CREATE INDEX IF NOT EXISTS idx_album_inflight_user ON album_inflight (user_id)",
    );
  }

  async get(trackId: string | number, quality = "lossy"): Promise<CachedTrack | null> {
    const res = await cachePool.query<Record<string, unknown>>(
      `SELECT ${SELECT_COLS} FROM telegram_cache WHERE track_id = $1 AND quality = $2`,
      [Number(trackId), quality],
    );
    const row = res.rows[0];
    return row === undefined ? null : rowToCachedTrack(row);
  }

  async save(
    trackId: string | number,
    telegramFileId: string,
    isCached: boolean,
    opts: SaveTrackOptions = {},
    quality = "lossy",
  ): Promise<void> {
    await cachePool.query(
      `
      INSERT INTO telegram_cache
          (track_id, quality, telegram_file_id, telegram_message_id,
           is_cached, has_metadata, artist, title, album,
           cover_url, duration, year, label, genre,
           codec, bitrate_kbps, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
      ON CONFLICT (track_id, quality) DO UPDATE SET
          telegram_file_id    = EXCLUDED.telegram_file_id,
          telegram_message_id = EXCLUDED.telegram_message_id,
          is_cached           = EXCLUDED.is_cached,
          has_metadata        = EXCLUDED.has_metadata,
          artist              = EXCLUDED.artist,
          title               = EXCLUDED.title,
          album               = EXCLUDED.album,
          cover_url           = EXCLUDED.cover_url,
          duration            = EXCLUDED.duration,
          year                = EXCLUDED.year,
          label               = EXCLUDED.label,
          genre               = EXCLUDED.genre,
          codec               = EXCLUDED.codec,
          bitrate_kbps        = EXCLUDED.bitrate_kbps,
          updated_at          = NOW()
      `,
      [
        Number(trackId),
        quality,
        telegramFileId,
        opts.telegram_message_id ?? null,
        isCached,
        opts.has_metadata ?? false,
        opts.artist ?? null,
        opts.title ?? null,
        opts.album ?? null,
        opts.cover_url ?? null,
        opts.duration ?? null,
        opts.year ?? null,
        opts.label ?? null,
        opts.genre ?? null,
        opts.codec ?? null,
        opts.bitrate_kbps ?? null,
      ],
    );
  }

  async getStaleUncached(olderThanHours = 24, limit = 50): Promise<CachedTrack[]> {
    const res = await cachePool.query<Record<string, unknown>>(
      `SELECT track_id, artist, title, album, cover_url, duration, year, label, genre
       FROM telegram_cache
       WHERE is_cached = FALSE AND updated_at < NOW() - $1 * INTERVAL '1 hour'
       ORDER BY updated_at ASC
       LIMIT $2`,
      [olderThanHours, limit],
    );
    // невыбранные запросом поля rowToCachedTrack молча дефолтит через ?? / Boolean(undefined)
    return res.rows.map(rowToCachedTrack);
  }

  /** двигает updated_at без апгрейда is_cached — трек, который упал на
   * рефреше, иначе выглядел бы «протухшим» вечно и монополизировал бы каждый
   * следующий батч getStaleUncached, оставляя остальные треки без шанса. */
  async touchStale(trackId: string | number): Promise<void> {
    await cachePool.query(
      "UPDATE telegram_cache SET updated_at = NOW() WHERE track_id = $1 AND is_cached = FALSE",
      [Number(trackId)],
    );
  }

  /** удаляет одну строку-пустышку (после того как её канальное сообщение уже
   * снесли) — иначе следующий getOrCacheTrack() отдаст мёртвый file_id из БД. */
  async deleteStubRow(trackId: string | number, quality: string): Promise<void> {
    await cachePool.query(
      "DELETE FROM telegram_cache WHERE track_id = $1 AND quality = $2 AND is_cached = FALSE",
      [Number(trackId), quality],
    );
  }

  async deleteOldStubs(olderThanDays = 7): Promise<number> {
    const res = await cachePool.query(
      `DELETE FROM telegram_cache WHERE is_cached = FALSE AND updated_at < NOW() - $1 * INTERVAL '1 day'`,
      [olderThanDays],
    );
    return res.rowCount ?? 0;
  }

  /** [total, cached] — одним round-trip'ом. */
  async counts(): Promise<[number, number]> {
    const res = await cachePool.query<{ total: string; cached: string }>(
      "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_cached) AS cached FROM telegram_cache",
    );
    const row = res.rows[0];
    return [parseInt(row?.total ?? "0", 10), parseInt(row?.cached ?? "0", 10)];
  }

  async insertInflightAlbum(args: {
    user_id: number;
    chat_id: number;
    album_id: number;
    progress_message_id: number | null;
  }): Promise<number> {
    return cachePool.transaction(async (c) => {
      await c.query("DELETE FROM album_inflight WHERE user_id = $1 AND album_id = $2", [
        args.user_id,
        args.album_id,
      ]);
      const res = await c.query<{ id: number }>(
        "INSERT INTO album_inflight (user_id, chat_id, album_id, progress_message_id) VALUES ($1, $2, $3, $4) RETURNING id",
        [args.user_id, args.chat_id, args.album_id, args.progress_message_id],
      );
      return res.rows[0]!.id;
    });
  }

  async markInflightTrackDone(inflightId: number, trackId: number): Promise<void> {
    await cachePool.query(
      "UPDATE album_inflight SET completed_track_ids = array_append(completed_track_ids, $2) WHERE id = $1 AND NOT ($2 = ANY(completed_track_ids))",
      [inflightId, trackId],
    );
  }

  async deleteInflight(inflightId: number): Promise<void> {
    await cachePool.query("DELETE FROM album_inflight WHERE id = $1", [inflightId]);
  }

  async listInflight(maxAgeHours = 6): Promise<InflightAlbum[]> {
    const res = await cachePool.query<Record<string, unknown>>(
      `SELECT id, user_id, chat_id, album_id, progress_message_id, completed_track_ids
       FROM album_inflight
       WHERE started_at > NOW() - $1 * INTERVAL '1 hour'
       ORDER BY started_at ASC`,
      [maxAgeHours],
    );
    return res.rows.map((r) => ({
      id: r.id as number,
      user_id: r.user_id as number,
      chat_id: r.chat_id as number,
      album_id: r.album_id as number,
      progress_message_id: (r.progress_message_id as number | null) ?? null,
      completed_track_ids: ((r.completed_track_ids as number[]) ?? []).map(Number),
    }));
  }

  async deleteOldInflight(olderThanHours = 6): Promise<number> {
    const res = await cachePool.query(
      `DELETE FROM album_inflight WHERE started_at < NOW() - $1 * INTERVAL '1 hour'`,
      [olderThanHours],
    );
    return res.rowCount ?? 0;
  }

  async dbSizeBytes(): Promise<number> {
    const res = await cachePool.query<{ pg_database_size: number }>(
      "SELECT pg_database_size(current_database())",
    );
    return res.rows[0]?.pg_database_size ?? 0;
  }
}
