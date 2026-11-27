/**
 * Контракт зависимости @dvxch/yandex-music (>=0.4.1): экспорты и поведение,
 * на которые опирается nowym. Без сети: fetch подменяется через new Client({ fetch }).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Client,
  ClientError,
  decryptEncraw,
  deviceIdFromToken,
  ForbiddenError,
  GoneError,
  generateDeviceId,
  InvalidResponseError,
  LosslessDownloadInfo,
  NetworkError,
  NotFoundError,
  RealtimeClient,
  ServerError,
  TimedOutError,
  TooManyRequestsError,
  UnauthorizedError,
  YnisonClient,
  YnisonDeviceDisplacedError,
  YnisonUnauthorizedError,
} from "@dvxch/yandex-music";

type FetchStub = ConstructorParameters<typeof Client>[0] extends infer O
  ? O extends { fetch?: infer F }
    ? F
    : never
  : never;

function stubFetch(status: number, headers: Record<string, string> = {}): FetchStub {
  return (async () => ({
    status,
    headers,
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ error: { message: "x" } })).buffer,
  })) as unknown as FetchStub;
}

test("экспорты: классы и функции, которыми пользуется nowym", () => {
  assert.equal(typeof decryptEncraw, "function");
  assert.equal(typeof Client, "function");
  assert.equal(typeof YnisonClient, "function");
  assert.equal(typeof RealtimeClient, "function");
  assert.equal(typeof generateDeviceId, "function");
  assert.equal(typeof deviceIdFromToken, "function");
  assert.equal(typeof new Client().pollDeviceTokenOnce, "function");
});

test("классы ошибок экспортируются; HTTP-ошибки наследуют NetworkError", () => {
  for (const cls of [NotFoundError, TooManyRequestsError, ServerError, TimedOutError]) {
    assert.equal(typeof cls, "function");
    assert.ok(new cls("x") instanceof NetworkError, cls.name);
  }
  assert.equal(typeof UnauthorizedError, "function");
  assert.equal(typeof YnisonUnauthorizedError, "function");
  assert.equal(typeof YnisonDeviceDisplacedError, "function");
});

test("deviceIdFromToken: 12 hex, стабилен; generateDeviceId: hex", () => {
  assert.match(deviceIdFromToken("t"), /^[0-9a-f]{12}$/);
  assert.equal(deviceIdFromToken("t"), deviceIdFromToken("t"));
  assert.match(generateDeviceId(), /^[0-9a-f]+$/);
});

test("LosslessDownloadInfo.isLossless: flac / flac-mp4 true, mp3 false", () => {
  const make = (codec: string) => LosslessDownloadInfo.deJson({ codec, url: "u" });
  assert.equal(make("flac")?.isLossless, true);
  assert.equal(make("flac-mp4")?.isLossless, true);
  assert.equal(make("mp3")?.isLossless, false);
});

test("RealtimeClient.terminalError: геттер на прототипе, null до старта", () => {
  const desc = Object.getOwnPropertyDescriptor(RealtimeClient.prototype, "terminalError");
  assert.equal(typeof desc?.get, "function");
  assert.equal(new RealtimeClient({ token: "t" }).terminalError, null);
});

test("429 -> TooManyRequestsError со status 429 и retryAfterMs из Retry-After", async () => {
  const c = new Client({ token: "t", retries: 0, fetch: stubFetch(429, { "retry-after": "7" }) });
  await assert.rejects(
    () => c.accountStatus(),
    (e: unknown) => {
      assert.ok(e instanceof TooManyRequestsError);
      assert.equal(e.status, 429);
      assert.equal(e.retryAfterMs, 7000);
      return true;
    },
  );
});

test("503 -> ServerError", async () => {
  const c = new Client({ token: "t", retries: 0, fetch: stubFetch(503) });
  await assert.rejects(
    () => c.accountStatus(),
    (e: unknown) => {
      assert.ok(e instanceof ServerError);
      assert.equal(e.status, 503);
      return true;
    },
  );
});

const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("0.4.1: 403 -> ForbiddenError ⊂ UnauthorizedError; 410 -> GoneError ⊂ ClientError (не ретраятся)", async () => {
  for (const [status, cls] of [
    [403, ForbiddenError],
    [410, GoneError],
  ] as const) {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return jsonRes(status, { error: { message: "x" } });
    }) as unknown as typeof fetch;
    const c = new Client({ token: "t", retries: 2, retryBaseMs: 1, fetch: fetchFn });
    await assert.rejects(() => c.accountStatus(), cls);
    assert.equal(calls, 1, `${status} не ретраится`);
  }
  assert.ok(new ForbiddenError("x") instanceof UnauthorizedError);
  assert.ok(new GoneError("x") instanceof ClientError);
});

test("0.4.1: 2xx с error без result -> InvalidResponseError", async () => {
  const fetchFn = (async () => jsonRes(200, { error: { name: "x", message: "bad" } })) as unknown as typeof fetch;
  const c = new Client({ token: "t", retries: 0, fetch: fetchFn });
  await assert.rejects(() => c.accountStatus(), InvalidResponseError);
});

test("0.4.1: retrieve() на чужой хост не отправляет Authorization", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const fetchFn = (async (input: unknown, init?: { headers?: Record<string, string> | Headers }) => {
    const h = new Headers(init?.headers);
    seen.push({ url: String(input), auth: h.get("authorization") });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as unknown as typeof fetch;
  const c = new Client({ token: "secret", retries: 0, fetch: fetchFn });
  await c.request.retrieve("https://cdn.example.com/x.json", 5000);
  await c.request.retrieve("https://api.music.yandex.net/x", 5000);
  assert.equal(seen[0]?.auth, null);
  assert.ok(seen[1]?.auth, "на api.music.yandex.net токен есть");
});

test("0.4.1: About.geoRegionIso и withOptions({retries: 0})", async () => {
  let calls = 0;
  const fetchFn = (async (input: unknown) => {
    calls++;
    if (String(input).includes("account/about")) {
      return jsonRes(200, { result: { geoRegionIso: "RU", userSessionRegionIso: "KZ" } });
    }
    return jsonRes(503, { error: "x" });
  }) as unknown as typeof fetch;
  const c = new Client({ token: "t", retries: 2, retryBaseMs: 1, fetch: fetchFn });
  const about = await c.accountAbout();
  assert.equal(about?.geoRegionIso, "RU");
  assert.equal(about?.userSessionRegionIso, "KZ");
  calls = 0;
  await assert.rejects(() => c.withOptions({ retries: 0 }).accountStatus(), ServerError);
  assert.equal(calls, 1);
});

test("0.4.1: models.client не перечисляется и не попадает в JSON", () => {
  const c = new Client({ token: "secret" });
  const info = LosslessDownloadInfo.deJson({ codec: "flac", url: "u" }, c);
  assert.ok(info);
  assert.ok(!Object.keys(info).includes("client"));
  assert.ok(!JSON.stringify(info).includes("secret"));
});
