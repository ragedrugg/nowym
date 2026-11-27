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

  private readonly dsnFactory: () => string;
  private readonly name: string;
  // не заданы — берутся из Settings в initialize(): на импорте env мог быть
  // ещё не загружен и шёл мимо валидации.
  private readonly minSize: number | undefined;
  private readonly maxSize: number | undefined;

  constructor(dsnFactory: () => string, name: string, minSize?: number, maxSize?: number) {
    this.dsnFactory = dsnFactory;
    this.name = name;
    this.minSize = minSize;
    this.maxSize = maxSize;
  }

  /** размеры пула: явные из конструктора, иначе DB_POOL_MIN/MAX из Settings. */
  private sizes(): { min: number; max: number } {
    if (this.minSize !== undefined && this.maxSize !== undefined) return { min: this.minSize, max: this.maxSize };
    const s = getSettings();
    return { min: this.minSize ?? s.DB_POOL_MIN, max: this.maxSize ?? s.DB_POOL_MAX };
  }

  async initialize(): Promise<void> {
    if (this.pool !== null) return;
    const { min, max } = this.sizes();
    this.pool = new Pool({
      connectionString: this.dsnFactory(),
      min,
      max,
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
    log.info(`[pool/${this.name}] готов (min=${min}, max=${max})`);
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

export const usersPool = new DatabasePool(() => getSettings().POSTGRES_USERS_DSN, "users");

export const cachePool = new DatabasePool(() => getSettings().POSTGRES_CACHE_DSN, "cache");

export async function initializeAll(): Promise<void> {
  await usersPool.initialize();
  await cachePool.initialize();
}

export async function closeAll(): Promise<void> {
  await usersPool.close();
  await cachePool.close();
}
