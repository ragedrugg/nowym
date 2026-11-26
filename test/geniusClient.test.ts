/** Genius: негативный кэш только для definitive-ответов, с TTL; сбои не кэшируются.
 * Без сети: fake fetch + инжектируемые часы. */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { GeniusClient } from "../src/genius/client.ts";

const TTL_MS = 15 * 60_000;
const PAGE = `<div data-lyrics-container="true">hello<br/>world</div>`;
const hitsBody = (n: number) => ({
  response: {
    hits: Array.from({ length: n }, () => ({
      result: { title: "Song", url: "https://genius.com/song", primary_artist: { name: "Art" } },
    })),
  },
});

type Handler = (url: string) => { status?: number; json?: unknown; text?: string } | Error;

function make(handler: { fn: Handler }) {
  const clock = { t: 5_000_000 };
  const calls = { n: 0 };
  const fakeFetch = async (url: string) => {
    calls.n += 1;
    const r = handler.fn(String(url));
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.json, text: async () => r.text ?? "" };
  };
  const client = new GeniusClient("tok", { fetch: fakeFetch as never, now: () => clock.t });
  return { client, clock, calls };
}

test("searchSong: исключение/429 не кэшируется, повтор; zero hits кэшируется до TTL", async () => {
  const h: { fn: Handler } = { fn: () => ({ status: 429 }) };
  const { client, clock, calls } = make(h);
  assert.equal(await client.searchSong("q"), null);
  assert.equal(await client.searchSong("q"), null);
  assert.equal(calls.n, 2, "429 не кэшируется");

  h.fn = () => ({ json: hitsBody(0) });
  assert.equal(await client.searchSong("q"), null);
  assert.equal(await client.searchSong("q"), null);
  assert.equal(calls.n, 3, "zero hits закэширован");
  clock.t += TTL_MS + 1;
  h.fn = () => ({ json: hitsBody(1) });
  assert.deepEqual(await client.searchSong("q"), { artist: "Art", title: "Song" });
  assert.equal(calls.n, 4);
  await client.searchSong("q");
  assert.equal(calls.n, 4, "позитив закэширован");
});

test("getLyrics: сбой скрейпа (Cloudflare 403) не кэшируется; нет контейнера -> негатив с TTL", async () => {
  const h: { fn: Handler } = {
    fn: (u) => (u.includes("api.genius.com") ? { json: hitsBody(1) } : { status: 403 }),
  };
  const { client, clock, calls } = make(h);
  assert.equal(await client.getLyrics("Art", "Song"), null);
  assert.equal(await client.getLyrics("Art", "Song"), null);
  assert.equal(calls.n, 4, "2 поиска + 2 скрейпа, ничего не закэшировано");

  h.fn = (u) => (u.includes("api.genius.com") ? { json: hitsBody(1) } : { text: "<html></html>" });
  assert.equal(await client.getLyrics("Art", "Song"), null);
  const n = calls.n;
  assert.equal(await client.getLyrics("Art", "Song"), null);
  assert.equal(calls.n, n, "definitive no-lyrics из кэша");
  clock.t += TTL_MS + 1;
  h.fn = (u) => (u.includes("api.genius.com") ? { json: hitsBody(1) } : { text: PAGE });
  assert.equal(await client.getLyrics("Art", "Song"), "hello\nworld");
  const n2 = calls.n;
  assert.equal(await client.getLyrics("Art", "Song"), "hello\nworld");
  assert.equal(calls.n, n2, "позитив кэширован");
});

test("lyricsForPhrase: сбой поиска не кэшируется, повтор успешен", async () => {
  const h: { fn: Handler } = { fn: () => new Error("network") };
  const { client, calls } = make(h);
  assert.equal(await client.lyricsForPhrase("p"), null);
  assert.equal(await client.lyricsForPhrase("p"), null);
  assert.equal(calls.n, 2);
  h.fn = (u) => (u.includes("api.genius.com") ? { json: hitsBody(1) } : { text: PAGE });
  assert.equal(await client.lyricsForPhrase("p"), "hello\nworld");
});
