/** БД пользователей — токены зашифрованы через infra/crypto. */
import { crypto } from "../infra/crypto.ts";
import { usersPool } from "./pool.ts";
import { getLogger } from "../infra/logging.ts";

const log = getLogger("storage.users");

export interface UserCreds {
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
}

export class UsersDb {
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
    log.debug(`creds сохранены для ${userId}`);
  }

  async get(userId: number): Promise<UserCreds | null> {
    const res = await usersPool.query<{
      access_token: string;
      refresh_token: string | null;
      expires_at: number | null;
    }>(
      "SELECT access_token, refresh_token, expires_at FROM user_credentials WHERE user_id = $1",
      [userId],
    );
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
    const res = await usersPool.query(
      "DELETE FROM user_credentials WHERE user_id = $1",
      [userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async count(): Promise<number> {
    const res = await usersPool.query<{ count: string }>(
      "SELECT COUNT(*) FROM user_credentials",
    );
    return parseInt(res.rows[0]?.count ?? "0", 10);
  }

  async dbSizeBytes(): Promise<number> {
    const res = await usersPool.query<{ pg_database_size: number }>(
      "SELECT pg_database_size(current_database())",
    );
    return res.rows[0]?.pg_database_size ?? 0;
  }

  /** произвольный существующий юзер — нужен один валидный токен для служебных запросов к CDN. */
  async anyUserId(): Promise<number | null> {
    const res = await usersPool.query<{ user_id: number }>(
      "SELECT user_id FROM user_credentials LIMIT 1",
    );
    return res.rows[0]?.user_id ?? null;
  }
}
