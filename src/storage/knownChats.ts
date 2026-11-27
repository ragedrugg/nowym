/** Реестр приватных чатов, писавших боту — получатели админ-рассылки. В отличие
 * от user_credentials (только залогиненные, чистится на /logout), сюда попадает
 * КАЖДЫЙ, кто написал в личку, независимо от логина. */
import { LRUMap } from "../infra/lruMap.ts";
import { usersPool } from "./pool.ts";

// R3: last_seen_at нужен только рассылке, а UPSERT шёл на каждое приватное
// сообщение. Пишем не чаще раза в 6ч на чат; 10k чатов в памяти ≈ сотни КБ.
const TOUCH_INTERVAL_MS = 6 * 3600_000;
const TOUCH_LRU_MAX = 10_000;

export class KnownChatsDb {
  // chat_id → момент (мс) последней успешной записи
  private readonly lastTouch = new LRUMap<number, number>(TOUCH_LRU_MAX);
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async initSchema(): Promise<void> {
    await usersPool.query(`
      CREATE TABLE IF NOT EXISTS known_chats (
        chat_id        BIGINT       PRIMARY KEY,
        first_seen_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        last_seen_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      ) WITH (fillfactor = 80)
    `);
  }

  /** Приватный чат: chat_id === user_id. Повторный touch того же чата в пределах
   * TOUCH_INTERVAL_MS в БД не идёт; сбой записи метку не ставит. */
  async touch(chatId: number): Promise<void> {
    const now = this.now();
    const last = this.lastTouch.get(chatId);
    if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return;
    this.lastTouch.set(chatId, now);
    try {
      await this.upsert(chatId);
    } catch (e) {
      if (this.lastTouch.peek(chatId) === now) this.lastTouch.delete(chatId);
      throw e;
    }
  }

  private async upsert(chatId: number): Promise<void> {
    await usersPool.query(
      `
      INSERT INTO known_chats (chat_id, last_seen_at)
      VALUES ($1, NOW())
      ON CONFLICT (chat_id) DO UPDATE SET last_seen_at = NOW()
      `,
      [chatId],
    );
  }

  async allChatIds(): Promise<number[]> {
    const res = await usersPool.query<{ chat_id: number }>("SELECT chat_id FROM known_chats ORDER BY chat_id");
    return res.rows.map((r) => r.chat_id);
  }

  /** Идемпотентно: без бэкофилла рассылка после деплоя видела бы только тех, кто
   * написал боту заново. chat_id приватного чата === user_id, join не нужен. */
  async backfillFromUserCredentials(): Promise<void> {
    await usersPool.query(`
      INSERT INTO known_chats (chat_id)
      SELECT user_id FROM user_credentials
      ON CONFLICT (chat_id) DO NOTHING
    `);
  }

  async remove(chatId: number): Promise<void> {
    // чат снова напишет — должен вернуться в реестр сразу, а не через 6ч
    this.lastTouch.delete(chatId);
    await usersPool.query("DELETE FROM known_chats WHERE chat_id = $1", [chatId]);
  }

  async count(): Promise<number> {
    const res = await usersPool.query<{ count: string }>("SELECT COUNT(*) FROM known_chats");
    return parseInt(res.rows[0]?.count ?? "0", 10);
  }
}
