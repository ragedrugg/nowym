/**
 * pg-пулы к двум БД: users (токены/настройки) и cache (file_id треков).
 *
 * BIGINT (int8, OID 20) парсим в Number: все наши bigint'ы (telegram id,
 * yandex track/album id, epoch-секунды) надёжно < 2^53.
 */
import pg from "pg";
import { getLogger } from "../infra/logging.ts";
import { getSettings } from "../settings.ts";

const { Pool, types } = pg;

types.setTypeParser(20, (v) => parseInt(v, 10)); // int8
types.setTypeParser(1700, (v) => parseFloat(v)); // numeric

const log = getLogger("storage.pool");

export class DatabasePool {
  private pool: pg.Pool | null = null;

  constructor(
    private readonly dsnFactory: () => string,
    private readonly name: string,
    private readonly minSize: number,
    private readonly maxSize: number,
  ) {}

  async initialize(): Promise<void> {
    if (this.pool !== null) return;
    this.pool = new Pool({
      connectionString: this.dsnFactory(),
      min: this.minSize,
      max: this.maxSize,
      statement_timeout: 30_000,
      // зависшая транзакция не должна вечно держать локи/коннект
      idle_in_transaction_session_timeout: 30_000,
    });
    // pg эмитит 'error' на пуле при обрыве простаивающего коннекта — без слушателя Node роняет процесс
    // пул сам заменит дохлый коннект на следующем connect()
    this.pool.on("error", (err) => {
      log.error(`[pool/${this.name}] ошибка простаивающего клиента: ${err.message}`);
    });
    // прогреваем одно соединение, чтобы упасть на старте при кривом DSN
    const c = await this.pool.connect();
    c.release();
    log.info(`[pool/${this.name}] готов (min=${this.minSize}, max=${this.maxSize})`);
  }

  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>> {
    if (this.pool === null) throw new Error(`[pool/${this.name}] не инициализирован`);
    return this.pool.query<R>(text, params);
  }

  async transaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    if (this.pool === null) throw new Error(`[pool/${this.name}] не инициализирован`);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.pool === null) return;
    await this.pool.end();
    this.pool = null;
    log.info(`[pool/${this.name}] закрыт`);
  }

  /** Без обращения к БД — для /health. */
  stats(): { total: number; idle: number; waiting: number } {
    return {
      total: this.pool?.totalCount ?? 0,
      idle: this.pool?.idleCount ?? 0,
      waiting: this.pool?.waitingCount ?? 0,
    };
  }

  /** Не бросает исключение — для /health. */
  async ping(): Promise<boolean> {
    if (this.pool === null) return false;
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
}

// min/max нужны в конструкторе — читаем env напрямую с теми же дефолтами что в settings.ts
const DB_POOL_MIN = parseInt(process.env.DB_POOL_MIN ?? "1", 10);
const DB_POOL_MAX = parseInt(process.env.DB_POOL_MAX ?? "5", 10);

export const usersPool = new DatabasePool(() => getSettings().POSTGRES_USERS_DSN, "users", DB_POOL_MIN, DB_POOL_MAX);

export const cachePool = new DatabasePool(() => getSettings().POSTGRES_CACHE_DSN, "cache", DB_POOL_MIN, DB_POOL_MAX);

export async function initializeAll(): Promise<void> {
  await usersPool.initialize();
  await cachePool.initialize();
}

export async function closeAll(): Promise<void> {
  await usersPool.close();
  await cachePool.close();
}
