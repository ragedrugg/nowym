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

test("D14: размеры пула без явных min/max берутся из Settings (DB_POOL_*), а не из env на импорте", () => {
  const prevMin = process.env.DB_POOL_MIN;
  const prevMax = process.env.DB_POOL_MAX;
  // getSettings() ленивый и кэшируется при первом вызове — задаём env до него
  process.env.DB_POOL_MIN = "2";
  process.env.DB_POOL_MAX = "9";
  try {
    const sizes = (p: DatabasePool) => (p as unknown as { sizes(): { min: number; max: number } }).sizes();
    assert.deepEqual(sizes(new DatabasePool(() => "postgres://x", "test")), { min: 2, max: 9 });
    assert.deepEqual(
      sizes(new DatabasePool(() => "postgres://x", "test", 1, 5)),
      { min: 1, max: 5 },
      "явные — как есть",
    );
  } finally {
    if (prevMin === undefined) delete process.env.DB_POOL_MIN;
    else process.env.DB_POOL_MIN = prevMin;
    if (prevMax === undefined) delete process.env.DB_POOL_MAX;
    else process.env.DB_POOL_MAX = prevMax;
  }
});
