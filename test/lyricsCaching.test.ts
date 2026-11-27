/** Негативное кэширование лирики / wave-цвета: только definitive-ответ, с TTL; сбои не кэшируются.
 * Без сети: fake lib + инжектируемые часы. */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { NotFoundError } from "@dvxch/yandex-music";

import { YandexClient } from "../src/yandex/client.ts";
import { createYandexSharedCaches, type YandexSharedCaches } from "../src/yandex/sharedCaches.ts";

const TTL_MS = 15 * 60_000;

function make(caches: YandexSharedCaches = createYandexSharedCaches()) {
  const clock = { t: 1_000_000 };
  const client = new YandexClient(
    "t",
    null,
    {},
    async () => {},
    () => clock.t,
    caches,
  );
  const setLib = (lib: unknown) => {
    (client as unknown as { lib: unknown }).lib = lib;
  };
  return { client, clock, setLib, caches };
}

test("lyrics: fetchLyrics бросает (сбой) -> не кэшируется, второй вызов повторяет", async () => {
  const { client, setLib } = make();
  let calls = 0;
  setLib({
    tracksLyrics: async () => ({
      fetchLyrics: async () => {
        calls += 1;
        if (calls === 1) throw new Error("timeout");
        return "text";
      },
    }),
  });
  assert.equal(await client.getTrackLyrics(1), null);
  assert.equal(await client.getTrackLyrics(1), "text");
  assert.equal(calls, 2);
});

test("lyrics: NotFound -> null кэшируется до TTL, затем повтор", async () => {
  const { client, clock, setLib } = make();
  let calls = 0;
  setLib({
    tracksLyrics: async () => {
      calls += 1;
      if (calls === 1) throw new NotFoundError("nf");
      return { fetchLyrics: async () => "now exists" };
    },
  });
  assert.equal(await client.getTrackLyrics(7), null);
  assert.equal(await client.getTrackLyrics(7), null);
  assert.equal(calls, 1, "внутри TTL — из кэша");
  clock.t += TTL_MS + 1;
  assert.equal(await client.getTrackLyrics(7), "now exists");
  assert.equal(calls, 2);
});

test("lyrics: tracksLyrics вернул null (нет текста) -> негатив с TTL", async () => {
  const { client, clock, setLib } = make();
  let calls = 0;
  setLib({
    tracksLyrics: async () => {
      calls += 1;
      return null;
    },
  });
  await client.getTrackLyrics(5);
  await client.getTrackLyrics(5);
  assert.equal(calls, 1);
  clock.t += TTL_MS + 1;
  await client.getTrackLyrics(5);
  assert.equal(calls, 2);
});

test("lyrics: положительный результат кэшируется без TTL", async () => {
  const { client, clock, setLib } = make();
  let calls = 0;
  setLib({
    tracksLyrics: async () => {
      calls += 1;
      return { fetchLyrics: async () => "la la" };
    },
  });
  assert.equal(await client.getTrackLyrics(9), "la la");
  clock.t += 100 * TTL_MS;
  assert.equal(await client.getTrackLyrics(9), "la la");
  assert.equal(calls, 1);
});

test("wave: ошибка -> не кэшируется; нет агента -> негатив с TTL; цвет кэшируется", async () => {
  const { client, clock, setLib, caches } = make();
  let calls = 0;
  let mode: "err" | "none" | "color" = "err";
  setLib({
    albumsSimilarEntities: async () => {
      calls += 1;
      if (mode === "err") throw new Error("boom");
      return { items: [] };
    },
  });
  assert.equal(await client.getAlbumWaveColor(1), null);
  assert.equal(await client.getAlbumWaveColor(1), null);
  assert.equal(calls, 2, "после ошибки повторяет");

  mode = "none";
  assert.equal(await client.getAlbumWaveColor(1), null);
  assert.equal(await client.getAlbumWaveColor(1), null);
  assert.equal(calls, 3, "definitive null кэширован");
  clock.t += TTL_MS + 1;
  mode = "color";
  await client.getAlbumWaveColor(1);
  assert.equal(calls, 4, "после TTL повтор");

  // положительный цвет кэшируется навсегда
  caches.waveColor.set(2, "#fff");
  clock.t += 100 * TTL_MS;
  assert.equal(await client.getAlbumWaveColor(2), "#fff");
  assert.equal(calls, 4);
});

test("R1: лирика, wave-цвет и негатив общие для клиентов разных юзеров", async () => {
  const caches = createYandexSharedCaches();
  const a = make(caches);
  const b = make(caches);
  let calls = 0;
  const lib = {
    tracksLyrics: async (id: string) => {
      calls += 1;
      if (id === "404") throw new NotFoundError("nf");
      return { fetchLyrics: async () => "shared text" };
    },
  };
  a.setLib(lib);
  b.setLib(lib);
  assert.equal(await a.client.getTrackLyrics(11), "shared text");
  assert.equal(await b.client.getTrackLyrics(11), "shared text");
  assert.equal(await a.client.getTrackLyrics(404), null);
  assert.equal(await b.client.getTrackLyrics(404), null);
  assert.equal(calls, 2, "второй юзер берёт и текст, и негатив из общего кэша");
  caches.waveColor.set(3, "#123456");
  assert.equal(await b.client.getAlbumWaveColor(3), "#123456");
});
