/**
 * Контракт зависимости @dvxch/yandex-music (>=0.4.0): экспорты и поведение,
 * на которые опирается nowym. Без сети: fetch подменяется через new Client({ fetch }).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Client,
  decryptEncraw,
  deviceIdFromToken,
  generateDeviceId,
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
