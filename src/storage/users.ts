/** БД пользователей — токены зашифрованы через infra/crypto. */
import { crypto } from "../infra/crypto.ts";
import { getLogger } from "../infra/logging.ts";
import { LRUMap } from "../infra/lruMap.ts";
import { usersPool } from "./pool.ts";

const log = getLogger("storage.users");

export interface UserCreds {
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
}

// R6: resolveToken на каждое нажатие в inline делал SELECT + 2 расшифровки.
// Короткий кэш расшифрованных creds; save/delete сбрасывают его сразу (процесс
// один, других писателей user_credentials нет).
const CREDS_TTL_MS = 60_000;
const CREDS_LRU_MAX = 2000;

export class UsersDb {
  private readonly credsCache = new LRUMap<number, { creds: UserCreds | null; at: number }>(CREDS_LRU_MAX);
  // счётчик записей на юзера (растёт только у тех, кто логинился/выходил):
  // get, начавшийся до save/delete, не кладёт в кэш старое
  private readonly writeGen = new Map<number, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private invalidate(userId: number): void {
    this.credsCache.delete(userId);
    this.writeGen.set(userId, (this.writeGen.get(userId) ?? 0) + 1);
  }

  async initSchema(): Promise<void> {
    await usersPool.query(`
      CREATE TABLE IF NOT EXISTS user_credentials (
        user_id        BIGINT       PRIMARY KEY,
        access_token   TEXT         NOT NULL,
        refresh_token  TEXT,
        expires_at     BIGINT,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      ) WITH (fillfactor = 80)
    `);
  }

  async save(
    userId: number,
    accessToken: string,
    refreshToken: string | null = null,
    expiresIn: number | null = null,
  ): Promise<void> {
    // != null, а не truthy: expiresIn=0 ("уже истёк") иначе схлопывался бы
    // с "срок не задан" и токен считался бы вечным
    const expiresAt = expiresIn != null ? Math.floor(Date.now() / 1000) + expiresIn : null;
    this.invalidate(userId);
    await usersPool.query(
      `
      INSERT INTO user_credentials
          (user_id, access_token, refresh_token, expires_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
          access_token  = EXCLUDED.access_token,
          refresh_token = EXCLUDED.refresh_token,
          expires_at    = EXCLUDED.expires_at,
          updated_at    = NOW()
      `,
      [userId, crypto.encrypt(accessToken), crypto.encrypt(refreshToken), expiresAt],
    );
    this.invalidate(userId);
    log.debug(`creds сохранены для ${userId}`);
  }

  async get(userId: number): Promise<UserCreds | null> {
    const hit = this.credsCache.get(userId);
    if (hit !== undefined && this.now() - hit.at < CREDS_TTL_MS) return hit.creds && { ...hit.creds };
    const gen = this.writeGen.get(userId) ?? 0;
    const creds = await this.load(userId);
    if ((this.writeGen.get(userId) ?? 0) === gen) this.credsCache.set(userId, { creds, at: this.now() });
    return creds && { ...creds };
  }

  private async load(userId: number): Promise<UserCreds | null> {
    const res = await usersPool.query<{
      access_token: string;
      refresh_token: string | null;
      expires_at: number | null;
    }>("SELECT access_token, refresh_token, expires_at FROM user_credentials WHERE user_id = $1", [userId]);
    const row = res.rows[0];
    if (row === undefined) return null;
    return {
      access_token: crypto.decrypt(row.access_token),
      refresh_token: crypto.decrypt(row.refresh_token),
      expires_at: row.expires_at,
    };
  }

  async getToken(userId: number): Promise<string | null> {
    return (await this.get(userId))?.access_token ?? null;
  }

  async delete(userId: number): Promise<boolean> {
    this.invalidate(userId);
    const res = await usersPool.query("DELETE FROM user_credentials WHERE user_id = $1", [userId]);
    this.invalidate(userId);
    return (res.rowCount ?? 0) > 0;
  }

  async count(): Promise<number> {
    const res = await usersPool.query<{ count: string }>("SELECT COUNT(*) FROM user_credentials");
    return parseInt(res.rows[0]?.count ?? "0", 10);
  }

  async dbSizeBytes(): Promise<number> {
    const res = await usersPool.query<{ pg_database_size: number }>("SELECT pg_database_size(current_database())");
    return res.rows[0]?.pg_database_size ?? 0;
  }

  /** до `limit` юзеров с токенами, свежие первыми (детерминированный порядок) — кандидаты для служебных запросов к CDN. */
  async candidateUserIds(limit = 5): Promise<number[]> {
    const res = await usersPool.query<{ user_id: number }>(
      "SELECT user_id FROM user_credentials ORDER BY updated_at DESC, user_id DESC LIMIT $1",
      [limit],
    );
    return res.rows.map((r) => r.user_id);
  }
}
