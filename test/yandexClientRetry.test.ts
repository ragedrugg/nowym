/** YandexClient: retry/429 (lib 0.4.0 TooManyRequestsError), потолок запросов,
 * bare id для get-file-info, typed-путь лендинга. Без сети: fake fetch / fake lib. */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { YandexClient } from "../src/yandex/client.ts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** fake fetch: account/status отдаёт ok, остальное — через handler; считает НЕ-init вызовы. */
function makeFetch(handler: () => Response) {
  const state = { calls: 0 };
  const fetchFn = async (input: unknown): Promise<Response> => {
    const url = String((input as { url?: string }).url ?? input);
    if (url.includes("account/status")) return json({ result: { account: { uid: 1 } } });
    state.calls += 1;
    return handler();
  };
  return { state, fetchFn: fetchFn as unknown as typeof fetch };
}

const noSleepLib = { retryBaseMs: 1, retryMaxMs: 4000 };

test("429 с Retry-After > retryMaxMs: nowym ждёт >= retryAfterMs, всего 3 запроса", async () => {
  const { state, fetchFn } = makeFetch(() => json({ error: "slow" }, 429, { "retry-after": "5" }));
  const sleeps: number[] = [];
  const client = new YandexClient("t", null, { fetch: fetchFn, ...noSleepLib }, async (ms) => {
    sleeps.push(ms);
  });
  const res = await client.getTrackById(42);
  assert.equal(res, null);
  assert.equal(sleeps.length, 2, "2 повтора nowym (потолок min(maxRetries,2))");
  for (const ms of sleeps) assert.ok(ms >= 5000, `пауза ${ms} < Retry-After 5000`);
  assert.ok(state.calls <= 6, `запросов ${state.calls} > 6`);
  assert.equal(state.calls, 3);
});

test("5xx: потолок запросов — только ретраи библиотеки, nowym не множит", async () => {
  const { state, fetchFn } = makeFetch(() => json({ error: "boom" }, 500));
  const client = new YandexClient("t", null, { fetch: fetchFn, ...noSleepLib }, async () => {});
  assert.equal(await client.getTrackById(42), null);
  assert.ok(state.calls <= 6, `запросов ${state.calls} > 6`);
  assert.equal(state.calls, 2, "LIB_RETRIES=1 -> 2 запроса, без повторов withRetry");
});

test("404 не ретраится: 1 запрос", async () => {
  const { state, fetchFn } = makeFetch(() => json({ error: "nf" }, 404));
  const client = new YandexClient("t", null, { fetch: fetchFn, ...noSleepLib }, async () => {});
  assert.equal(await client.getTrackById(42), null);
  assert.equal(state.calls, 1);
});

test("NetworkError с текстом '(429)' в сообщении не считается rate limit", async () => {
  const { NetworkError } = await import("@dvxch/yandex-music");
  const client = new YandexClient("t", null, {}, async () => assert.fail("не должен спать"));
  let calls = 0;
  (client as unknown as { lib: unknown }).lib = {
    tracks: async () => {
      calls += 1;
      throw new NetworkError("Invalid track id: 42912345 (429)");
    },
  };
  assert.equal(await client.getTrackById(1), null);
  assert.equal(calls, 1);
});

test("getLosslessDownload: в tracksFileInfo уходит bare id '123'", async () => {
  const client = new YandexClient("t");
  const seen: unknown[] = [];
  (client as unknown as { lib: unknown }).lib = {
    tracksFileInfo: async (id: unknown) => {
      seen.push(id);
      return null;
    },
  };
  await client.getLosslessDownload({ id: "123:456" } as never);
  assert.deepEqual(seen, ["123"]);
});

test("recentIdsFromLanding: otherTracks[].trackId.id (typed-путь), дедуп, bare id", async () => {
  const client = new YandexClient("t");
  (client as unknown as { lib: unknown }).lib = {
    landing: async () => ({
      blocks: [
        { data: { otherTracks: [{ trackId: { id: "1:9" } }, { trackId: { id: 2 } }, { trackId: { id: "1" } }] } },
        { data: undefined },
      ],
    }),
  };
  const ids = await (client as unknown as { recentIdsFromLanding(n: number): Promise<string[]> }).recentIdsFromLanding(
    10,
  );
  assert.deepEqual(ids, ["1", "2"]);
});

test("429 с Retry-After выше потолка паузы: сразу rethrow, без сна и повторов", async () => {
  const { state, fetchFn } = makeFetch(() => json({ error: "slow" }, 429, { "retry-after": "120" }));
  const sleeps: number[] = [];
  const client = new YandexClient("t", null, { fetch: fetchFn, ...noSleepLib }, async (ms) => {
    sleeps.push(ms);
  });
  assert.equal(await client.getTrackById(42), null);
  assert.deepEqual(sleeps, [], "ждать дольше потолка бессмысленно");
  assert.equal(state.calls, 1, "сервер уже отказал: новых запросов нет");
});

function fileInfoFetch(downloadInfo: Record<string, unknown>) {
  const urls: string[] = [];
  const state = { downloads: 0 };
  const fetchFn = async (input: unknown): Promise<Response> => {
    const url = String((input as { url?: string }).url ?? input);
    if (url.includes("account/status")) return json({ result: { account: { uid: 1 } } });
    if (url.includes("get-file-info")) {
      urls.push(url);
      return json({ result: { downloadInfo } });
    }
    state.downloads += 1;
    return new Response("x");
  };
  return { urls, state, fetchFn: fetchFn as unknown as typeof fetch };
}

const FLAC_INFO = {
  trackId: "123",
  quality: "lossless",
  codec: "flac-mp4",
  bitrate: 0,
  transport: "raw",
  urls: ["https://cdn.example/a"],
};

test("getLosslessDownload: запрос lossless + transports=raw, raw-ответ принимается", async () => {
  const { urls, fetchFn } = fileInfoFetch(FLAC_INFO);
  const client = new YandexClient("t", null, { fetch: fetchFn, ...noSleepLib }, async () => {});
  const info = await client.getLosslessDownload({ id: "123:456" } as never);
  assert.ok(info);
  assert.equal(urls.length, 1);
  const q = new URL(urls[0]!).searchParams;
  assert.equal(q.get("quality"), "lossless");
  assert.equal(q.get("transports"), "raw");
  assert.equal(q.get("trackId"), "123");
});

test("getLosslessDownload: сервер проигнорировал raw (encraw + key) => null, скачивания нет", async () => {
  const { state, fetchFn } = fileInfoFetch({ ...FLAC_INFO, transport: "encraw", key: "00ff" });
  const client = new YandexClient("t", null, { fetch: fetchFn, ...noSleepLib }, async () => {});
  assert.equal(await client.getLosslessDownload({ id: "123" } as never), null);
  assert.equal(state.downloads, 0);
});

test("D19: 401 → refresh → повтор не тратит попытку (работает и при YANDEX_MAX_RETRIES=0)", async () => {
  const { UnauthorizedError } = await import("@dvxch/yandex-music");
  const client = new YandexClient("t", null, {}, async () => assert.fail("не должен спать"));
  (client as unknown as { maxRetries: number }).maxRetries = 0;
  let refreshes = 0;
  (client as unknown as { tryRefreshToken: () => Promise<boolean> }).tryRefreshToken = async () => {
    refreshes += 1;
    return true;
  };
  let calls = 0;
  (client as unknown as { lib: unknown }).lib = {
    tracks: async () => {
      calls += 1;
      if (calls === 1) throw new UnauthorizedError("expired");
      return [{ id: 42 }];
    },
  };
  const res = await client.getTrackById(42);
  assert.deepEqual(res, { id: 42 });
  assert.equal(refreshes, 1);
  assert.equal(calls, 2);
});
