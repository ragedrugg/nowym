import { test } from "node:test";
import assert from "node:assert/strict";
import { TTLCache } from "../src/infra/memoryCache.ts";

test("get/set/delete", () => {
  const c = new TTLCache<number>(10, 300, 60);
  assert.equal(c.get("a"), null);
  c.set("a", 1);
  assert.equal(c.get("a"), 1);
  assert.equal(c.delete("a"), true);
  assert.equal(c.get("a"), null);
  c.close();
});

test("TTL — протухшее не отдаётся", () => {
  const c = new TTLCache<string>(10, 300, 60);
  c.set("k", "v", -1); // уже протух
  assert.equal(c.get("k"), null);
  c.close();
});

test("LRU-вытеснение по max_size", () => {
  const c = new TTLCache<number>(2, 300, 60);
  c.set("a", 1);
  c.set("b", 2);
  c.get("a"); // a становится свежим → выбьется b
  c.set("c", 3);
  assert.equal(c.get("b"), null);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("c"), 3);
  c.close();
});

test("stats", () => {
  const c = new TTLCache<number>(10, 300, 60);
  c.set("a", 1);
  c.get("a");
  c.get("miss");
  const s = c.stats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
  assert.equal(s.size, 1);
  c.close();
});
