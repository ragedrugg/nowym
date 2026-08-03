/** YandexClient.reportPlayback — best-effort playAudio-репорт.
 * lib — приватное поле, инжектим напрямую (getLib() при непустом this.lib
 * не трогает сеть), как priv()-каст в cache.test.ts. */
import { strict as assert } from "node:assert";
import { test } from "node:test";

// new YandexClient(...) читает getSettings() в конструкторе (client.ts:72) —
// та же ловушка, что и в auth.test.ts: settings.ts валидирует обязательные
// переменные лениво при первом вызове, а в чистом клоне/CI их нет.
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.TELEGRAM_CHANNEL_ID ??= "test-channel";
process.env.TOKEN_ENCRYPTION_KEY ??= "test-key";
process.env.POSTGRES_USERS_DSN ??= "postgres://test/test";
process.env.POSTGRES_CACHE_DSN ??= "postgres://test/test";
process.env.BOT_API_BASE_URL ??= "http://127.0.0.1:8081/bot";

import { YandexClient } from "../src/yandex/client.ts";
import type { YaTrack } from "../src/yandex/types.ts";

type FakeLib = { playAudio(opts: unknown): Promise<boolean> };
const withLib = (client: YandexClient, lib: FakeLib): void => {
  (client as unknown as { lib: FakeLib }).lib = lib;
};

test("reportPlayback: без albumId — не зовёт playAudio вообще", async () => {
  const client = new YandexClient("token");
  let calls = 0;
  withLib(client, {
    playAudio: async () => {
      calls += 1;
      return true;
    },
  });

  const track: YaTrack = { id: 42, albums: [] };
  await client.reportPlayback(track);

  assert.equal(calls, 0, "без album.id репортить нечего");
});

test("reportPlayback: с albumId — зовёт playAudio с правильными полями", async () => {
  const client = new YandexClient("token");
  let seenOpts: unknown = null;
  withLib(client, {
    playAudio: async (opts) => {
      seenOpts = opts;
      return true;
    },
  });

  const track: YaTrack = { id: "42:100500", albums: [{ id: 777 }] };
  await client.reportPlayback(track);

  assert.deepEqual(seenOpts, { trackId: "42", albumId: 777, from: "Мойва" });
});

test("reportPlayback: падение playAudio гасится, наружу не летит", async () => {
  const client = new YandexClient("token");
  withLib(client, {
    playAudio: async () => {
      throw new Error("сеть моргнула");
    },
  });

  const track: YaTrack = { id: 42, albums: [{ id: 777 }] };
  await assert.doesNotReject(client.reportPlayback(track));
});
