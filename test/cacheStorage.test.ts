/** CacheDb.getStaleUncached/touchStale — без БД: подменяем query у cachePool и пишем запросы/параметры. */
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";
import { CacheDb } from "../src/storage/cache.ts";
import { cachePool } from "../src/storage/pool.ts";

type Call = { text: string; params: unknown[] | undefined };
let calls: Call[] = [];
let rows: Record<string, unknown>[] = [];
const original = cachePool.query.bind(cachePool);

beforeEach(() => {
  calls = [];
  rows = [];
  // biome-ignore lint/suspicious/noExplicitAny: тестовая подмена пула
  (cachePool as any).query = async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    return { rows, rowCount: rows.length };
  };
});
afterEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: восстановление
  (cachePool as any).query = original;
});

test("getStaleUncached: выбирает quality и отдаёт её в результате", async () => {
  rows = [{ track_id: 1, quality: "lossless", artist: "a" }];
  const res = await new CacheDb().getStaleUncached(24, 50);
  assert.match(calls[0]?.text ?? "", /\bquality\b/);
  assert.deepEqual(calls[0]?.params, [24, 50]);
  assert.equal(res[0]?.quality, "lossless");
  assert.equal(res[0]?.track_id, "1");
});

test("getStaleUncached: дубли (track_id, quality) схлопываются", async () => {
  rows = [
    { track_id: 1, quality: "lossy" },
    { track_id: 1, quality: "lossy" },
    { track_id: 1, quality: "lossless" },
  ];
  const res = await new CacheDb().getStaleUncached();
  assert.deepEqual(
    res.map((r) => `${r.track_id}:${r.quality}`),
    ["1:lossy", "1:lossless"],
  );
});

test("touchStale: обновляет конкретную пару (track_id, quality) параметризованно", async () => {
  await new CacheDb().touchStale("7", "lossless");
  assert.match(calls[0]?.text ?? "", /track_id = \$1 AND quality = \$2/);
  assert.deepEqual(calls[0]?.params, [7, "lossless"]);
});
