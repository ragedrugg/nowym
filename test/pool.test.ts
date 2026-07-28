/** DatabasePool.stats()/ping() для /health — без живой БД (пул не инициализирован). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DatabasePool } from "../src/storage/pool.ts";

test("DatabasePool.stats: неинициализированный пул → нули", () => {
  const p = new DatabasePool(() => "postgres://x", "test", 1, 5);
  assert.deepEqual(p.stats(), { total: 0, idle: 0, waiting: 0 });
});

test("DatabasePool.ping: неинициализированный пул → false (без throw)", async () => {
  const p = new DatabasePool(() => "postgres://x", "test", 1, 5);
  assert.equal(await p.ping(), false);
});
