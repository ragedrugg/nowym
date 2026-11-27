/** StaleRefresher: выбор токена среди кандидатов, quality сквозь refresh. Без БД/сети. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { StaleRefresher } from "../src/services/stale.ts";

const track = {
  id: 1,
  title: "t",
  artists: [],
  albums: [],
  durationMs: 1000,
};

function build(opts: {
  candidates: number[];
  tokens: Record<number, string | null | "throw">;
  stale: { track_id: string; quality: string }[];
  limit?: number;
}) {
  const staleQueries: [number, number][] = [];
  const touched: [string, string | undefined][] = [];
  const downloads: { id: string; quality: unknown }[] = [];
  const clientUsers: number[] = [];
  const resolved: number[] = [];
  const yandex = {
    getTrackById: async () => track,
    getBestDownloadInfo: async () => ({ codec: "mp3", bitrateInKbps: 192 }),
    directLinkFromInfo: async () => "http://x",
    getAlbum: async () => null,
  };
  const deps = {
    cacheDb: {
      getStaleUncached: async (hours: number, limit: number) => {
        staleQueries.push([hours, limit]);
        return opts.stale;
      },
      touchStale: async (id: string, q?: string) => {
        touched.push([id, q]);
      },
    },
    usersDb: {
      candidateUserIds: async () => opts.candidates,
    },
    cacheService: {
      downloadAndCacheTrack: async (id: string, _u: unknown, _m: unknown, _c: unknown, q: unknown) => {
        downloads.push({ id, quality: q });
        return "fid";
      },
    },
    resolveToken: async (uid: number) => {
      resolved.push(uid);
      const t = opts.tokens[uid];
      if (t === "throw") throw new Error("decrypt failed");
      return t ?? null;
    },
    getYandexClient: async (_t: string, uid: number) => {
      clientUsers.push(uid);
      return yandex;
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: частичные фейки зависимостей
  return { r: new StaleRefresher(deps as any, opts.limit), touched, downloads, clientUsers, resolved, staleQueries };
}

test("мёртвый первый юзер → берётся следующий кандидат", async () => {
  const h = build({
    candidates: [10, 20, 30],
    tokens: { 10: null, 20: "tok", 30: "tok" },
    stale: [{ track_id: "1", quality: "lossy" }],
  });
  await h.r.refreshOnce();
  assert.deepEqual(h.resolved, [10, 20]);
  assert.deepEqual(h.clientUsers, [20]);
  assert.equal(h.downloads.length, 1);
});

test("токен, бросающий при расшифровке, пропускается", async () => {
  const h = build({
    candidates: [10, 20],
    tokens: { 10: "throw", 20: "tok" },
    stale: [{ track_id: "1", quality: "lossy" }],
  });
  await h.r.refreshOnce();
  assert.deepEqual(h.clientUsers, [20]);
});

test("все кандидаты мертвы → прогон пропущен чисто, без скачиваний", async () => {
  const h = build({
    candidates: [10, 20, 30],
    tokens: { 10: null, 20: "throw", 30: null },
    stale: [{ track_id: "1", quality: "lossy" }],
  });
  await h.r.refreshOnce();
  assert.deepEqual(h.resolved, [10, 20, 30]);
  assert.equal(h.clientUsers.length, 0);
  assert.equal(h.downloads.length, 0);
  assert.equal(h.touched.length, 0);
});

test("quality строки проходит в downloadAndCacheTrack", async () => {
  const h = build({ candidates: [1], tokens: { 1: "tok" }, stale: [{ track_id: "5", quality: "lossless" }] });
  await h.r.refreshOnce();
  assert.deepEqual(h.downloads, [{ id: "5", quality: "lossless" }]);
});

test("touchStale получает quality строки при неудаче", async () => {
  const h = build({ candidates: [1], tokens: { 1: "tok" }, stale: [{ track_id: "5", quality: "lossless" }] });
  // трек не найден → touchStale
  // biome-ignore lint/suspicious/noExplicitAny: подмена
  (h.r as any).deps.getYandexClient = async () => ({ getTrackById: async () => null });
  await h.r.refreshOnce();
  assert.deepEqual(h.touched, [["5", "lossless"]]);
});

test("R7: STALE_REFRESH_LIMIT уходит в выборку протухших (дефолт 50)", async () => {
  const def = build({ candidates: [1], tokens: { 1: "tok" }, stale: [] });
  await def.r.refreshOnce();
  assert.deepEqual(def.staleQueries, [[24, 50]]);
  const lim = build({ candidates: [1], tokens: { 1: "tok" }, stale: [], limit: 7 });
  await lim.r.refreshOnce();
  assert.deepEqual(lim.staleQueries, [[24, 7]]);
});

test("R7: STALE_REFRESH_LIMIT=0 — ни выборки, ни перекачек, start() не заводит цикл", async () => {
  const h = build({ candidates: [1], tokens: { 1: "tok" }, stale: [{ track_id: "1", quality: "lossy" }], limit: 0 });
  await h.r.refreshOnce();
  h.r.start(1);
  await new Promise((r) => setTimeout(r, 20));
  await h.r.stop();
  assert.deepEqual(h.staleQueries, []);
  assert.equal(h.downloads.length, 0);
  assert.deepEqual(h.resolved, []);
});
