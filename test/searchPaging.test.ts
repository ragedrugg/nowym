import assert from "node:assert/strict";
import { test } from "node:test";
import { TTLCache } from "../src/infra/memoryCache.ts";
import type { CacheService } from "../src/services/cache.ts";
import type { InlineResult } from "../src/services/search.ts";
import { SearchService } from "../src/services/search.ts";
import type { YandexClient } from "../src/yandex/client.ts";
import type { YaTrack } from "../src/yandex/types.ts";

// всегда "уже закэшировано" → allAlreadyCached()=true → resultsCache реально
// пишется (без этого cacheService=null в mkService по умолчанию — тест
// утечки между пользователями иначе тестировал бы пустое место).
const fakeCacheService = {
  cacheDb: { get: async () => ({ is_cached: true }) },
} as unknown as CacheService;

function mkTrack(id: number): YaTrack {
  return { id, title: `track ${id}` };
}

/** SearchService без сети: cacheService=null → createInlineResultFromTrack идёт
 * по text_media-пути (только строит InlineQueryResult.article, без I/O). */
function mkService(
  fake: Partial<YandexClient>,
  userId: number | null = null,
  resultsCache: TTLCache<InlineResult[]> = new TTLCache<InlineResult[]>(100, 300, 60),
  cacheService: CacheService | null = null,
): SearchService {
  return new SearchService(fake as unknown as YandexClient, resultsCache, cacheService, "nowymbot", userId);
}

test("recentResultsPaged — листает пул страницами, nextOffset двигается", async () => {
  const pool = Array.from({ length: 7 }, (_, i) => mkTrack(i));
  let calls = 0;
  const fake: Partial<YandexClient> = {
    getRecentTracks: async () => {
      calls += 1;
      return pool;
    },
  };
  const service = mkService(fake);

  const p0 = await service.recentResultsPaged("0", 3, "button", "text_media");
  assert.equal(p0.results.length, 3);
  assert.equal(p0.nextOffset, "3");

  const p1 = await service.recentResultsPaged("3", 3, "button", "text_media");
  assert.equal(p1.results.length, 3);
  assert.equal(p1.nextOffset, "6");

  const p2 = await service.recentResultsPaged("6", 3, "button", "text_media");
  assert.equal(p2.results.length, 1);
  assert.equal(p2.nextOffset, ""); // конец пула

  // пул из 7 треков переиспользуется (TTL 120с) — getRecentTracks не дёргается заново.
  assert.equal(calls, 1);
});

test("recentResultsPaged — offset за пределами пула отдаёт пусто без nextOffset", async () => {
  const pool = Array.from({ length: 4 }, (_, i) => mkTrack(i));
  const fake: Partial<YandexClient> = { getRecentTracks: async () => pool };
  const service = mkService(fake);

  const r = await service.recentResultsPaged("100", 3, "button", "text_media");
  assert.deepEqual(r, { results: [], nextOffset: "" });
});

test("searchTracksPaged — переход внутри страницы, затем на следующую страницу Яндекса", async () => {
  // страница 0: 5 треков (id 0-4), всего 12, perPage=5
  // страница 1: 5 треков (id 5-9)
  // страница 2: 2 трека (id 10-11) — последняя
  const pages: Record<number, YaTrack[]> = {
    0: Array.from({ length: 5 }, (_, i) => mkTrack(i)),
    1: Array.from({ length: 5 }, (_, i) => mkTrack(5 + i)),
    2: Array.from({ length: 2 }, (_, i) => mkTrack(10 + i)),
  };
  const fake: Partial<YandexClient> = {
    searchTracksPage: async (_query: string, page = 0) => ({
      tracks: pages[page] ?? [],
      total: 12,
      perPage: 5,
    }),
  };
  const service = mkService(fake);
  const pageSize = 3;

  // within страницы 0: 0..3 → id 0-2, ещё есть в этой же странице
  const a = await service.searchTracksPaged("q", "0:0", pageSize, "button", "text_media");
  assert.equal(a.results.length, 3);
  assert.equal(a.nextOffset, "0:3");

  // within страницы 0: 3..6, но в странице только 5 → id 3-4 (2шт), дальше на след. страницу
  const b = await service.searchTracksPaged("q", "0:3", pageSize, "button", "text_media");
  assert.equal(b.results.length, 2);
  assert.equal(b.nextOffset, "1:0"); // (0+1)*5=5 < 12

  const c = await service.searchTracksPaged("q", "1:0", pageSize, "button", "text_media");
  assert.equal(c.results.length, 3);
  assert.equal(c.nextOffset, "1:3");

  const d = await service.searchTracksPaged("q", "1:3", pageSize, "button", "text_media");
  assert.equal(d.results.length, 2);
  assert.equal(d.nextOffset, "2:0"); // (1+1)*5=10 < 12

  // последняя страница: 2 трека, дальше пусто — (2+1)*5=15 не < 12
  const e = await service.searchTracksPaged("q", "2:0", pageSize, "button", "text_media");
  assert.equal(e.results.length, 2);
  assert.equal(e.nextOffset, "");
});

test("recentResultsPaged — resultsCache общий на всех (как container.trackCache), но кэш не течёт между пользователями", async () => {
  // тот же TTLCache-инстанс, что и в container.ts — там resultsCache = единый
  // container.trackCache для ЛЮБОГО SearchService, независимо от userId.
  const sharedCache = new TTLCache<InlineResult[]>(100, 300, 60);

  const poolA = [mkTrack(100), mkTrack(101), mkTrack(102)];
  const poolB = [mkTrack(200), mkTrack(201), mkTrack(202)];
  const serviceA = mkService({ getRecentTracks: async () => poolA }, 1, sharedCache, fakeCacheService);
  const serviceB = mkService({ getRecentTracks: async () => poolB }, 2, sharedCache, fakeCacheService);

  // одинаковые layout/sendMode/offset/pageSize — ровно та ситуация (дефолтные
  // настройки), где ключ без соли userId у обоих совпал бы.
  const a = await serviceA.recentResultsPaged("0", 3, "button", "text_media");
  const b = await serviceB.recentResultsPaged("0", 3, "button", "text_media");

  const idsA = a.results.map((r) => (r as { id: string }).id);
  const idsB = b.results.map((r) => (r as { id: string }).id);
  assert.deepEqual(idsA, ["100", "101", "102"]);
  assert.deepEqual(idsB, ["200", "201", "202"], "юзер B не должен получить недавнее юзера A из общего кэша");
});
