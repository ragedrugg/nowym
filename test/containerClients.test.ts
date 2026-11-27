/** D18: Container.getYandexService — дедуп одновременного создания YandexClient. */
import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { Container } from "../src/bot/container.ts";
import { TTLCache } from "../src/infra/memoryCache.ts";
import { type YandexClient, YandexClientFactory } from "../src/yandex/client.ts";

const origCreate = YandexClientFactory.create;
afterEach(() => {
  YandexClientFactory.create = origCreate;
});

function mk(): Container {
  const c = new Container() as unknown as Record<string, unknown>;
  c.yandexClients = new TTLCache<YandexClient>(10, 3600, 600);
  c.searchServices = new TTLCache(10, 3600, 600);
  return c as unknown as Container;
}

function stubCreate(): { calls: string[]; release: () => void } {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  YandexClientFactory.create = async (token: string) => {
    calls.push(token);
    await gate;
    return { token } as unknown as YandexClient;
  };
  return { calls, release };
}

test("D18: параллельные getYandexService одного юзера — один lib.init(), один клиент", async () => {
  const c = mk();
  const { calls, release } = stubCreate();
  const ps = [c.getYandexService("T", 7), c.getYandexService("T", 7), c.getYandexService("T", 7)];
  release();
  const clients = await Promise.all(ps);
  assert.equal(calls.length, 1);
  assert.ok(clients.every((x) => x === clients[0]));
  assert.equal(await c.getYandexService("T", 7), clients[0], "дальше — из кэша");
  assert.equal(calls.length, 1);
});

test("D18: разные юзеры создаются независимо", async () => {
  const c = mk();
  const { calls, release } = stubCreate();
  const ps = [c.getYandexService("A", 1), c.getYandexService("B", 2)];
  release();
  const [a, b] = await Promise.all(ps);
  assert.deepEqual(calls.sort(), ["A", "B"]);
  assert.notEqual(a, b);
});

test("D18: invalidate во время создания — клиент со старым токеном не кэшируется", async () => {
  const c = mk();
  const { calls, release } = stubCreate();
  const p = c.getYandexService("OLD", 7);
  c.invalidateTokenCacheForUser(7);
  release();
  await p;
  await c.getYandexService("NEW", 7);
  assert.deepEqual(calls, ["OLD", "NEW"]);
});

test("D18: сбой создания не залипает — следующий вызов пробует снова", async () => {
  const c = mk();
  let n = 0;
  YandexClientFactory.create = async () => {
    n++;
    if (n === 1) throw new Error("init failed");
    return {} as YandexClient;
  };
  await assert.rejects(c.getYandexService("T", 7), /init failed/);
  await c.getYandexService("T", 7);
  assert.equal(n, 2);
});

test("L5: invalidate во время getTrackService — SearchService со старым клиентом не кэшируется", async () => {
  const c = mk();
  const { calls, release } = stubCreate();
  const p = c.getTrackService("OLD", 7);
  c.invalidateTokenCacheForUser(7); // logout / смена аккаунта
  release();
  const oldSvc = await p;
  const newSvc = await c.getTrackService("NEW", 7);
  assert.notEqual(newSvc, oldSvc, "после инвалидации — свежий SearchService");
  assert.deepEqual(calls, ["OLD", "NEW"]);
  assert.equal(await c.getTrackService("NEW", 7), newSvc, "без инвалидации — из кэша");
});

test("L5: invalidate, пока getTrackService ждёт уже готовый in-flight клиент — тоже не кэшируется", async () => {
  const c = mk();
  const { calls, release } = stubCreate();
  const inflight = c.getYandexService("OLD", 7); // клиент уже создаётся (например, из другого хендлера)
  const p = c.getTrackService("OLD", 7); // ждёт тот же in-flight
  c.invalidateTokenCacheForUser(7);
  release();
  await inflight;
  await p;
  await c.getTrackService("NEW", 7);
  assert.deepEqual(calls, ["OLD", "NEW"]);
});
