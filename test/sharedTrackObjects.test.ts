/** R2: Track-объекты — общий LRU между SearchService разных юзеров, без ссылки на lib-клиента. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { LRUMap } from "../src/infra/lruMap.ts";
import { TTLCache } from "../src/infra/memoryCache.ts";
import { SearchService } from "../src/services/search.ts";
import type { YandexClient } from "../src/yandex/client.ts";
import { detachClient, sharedTrackObjects } from "../src/yandex/sharedCaches.ts";
import type { YaTrack } from "../src/yandex/types.ts";

const mk = (userId: number, objs?: LRUMap<string, YaTrack>) =>
  new SearchService({} as YandexClient, new TTLCache(10, 60, 60), null, "nowymbot", userId, objs);

test("R2: трек, закэшированный сервисом юзера A, виден сервису юзера B", () => {
  const objs = new LRUMap<string, YaTrack>(10);
  mk(1, objs).cacheTrackObject({ id: 5, title: "song" });
  assert.equal(mk(2, objs).getTrackObject("5")?.title, "song");
});

test("R2: по умолчанию SearchService пишет в общий на процесс LRU", () => {
  mk(1).cacheTrackObject({ id: 987654, title: "global" });
  assert.equal(sharedTrackObjects.get("987654")?.title, "global");
});

test("R2: в общий кэш трек попадает без client (токен юзера не удерживается)", () => {
  const objs = new LRUMap<string, YaTrack>(10);
  const client = { token: "secret" };
  const track = {
    id: 7,
    title: "t",
    client,
    albums: [{ id: 1, title: "a", client }],
    artists: [{ name: "x", client }],
  };
  mk(1, objs).cacheTrackObject(track as unknown as YaTrack);
  const stored = objs.get("7") as unknown as Record<string, unknown>;
  assert.equal("client" in stored, false);
  assert.equal(JSON.stringify(stored).includes("secret"), false);
  assert.deepEqual(stored, { id: 7, title: "t", albums: [{ id: 1, title: "a" }], artists: [{ name: "x" }] });
});

test("detachClient: примитивы и null как есть", () => {
  assert.equal(detachClient(null), null);
  assert.equal(detachClient(3), 3);
  assert.deepEqual(detachClient([1, { client: 1, a: 2 }]), [1, { a: 2 }]);
});
