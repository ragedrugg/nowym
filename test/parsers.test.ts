/** parseSearchQuery: пустой запрос, ссылки Spotify, произвольный текст. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSearchQuery } from "../src/infra/parsers.ts";

test("пустой / только пробелы → empty", () => {
  assert.deepEqual(parseSearchQuery(""), { type: "empty" });
  assert.deepEqual(parseSearchQuery("   \n"), { type: "empty" });
});

test("ссылка на трек → track_link", () => {
  const id = "4iV5W9uYEdYUVa79Axb7Rh"; // валидный Spotify id (22 base62)
  assert.deepEqual(parseSearchQuery(`https://open.spotify.com/track/${id}`), {
    type: "track_link",
    track_id: id,
  });
  assert.deepEqual(parseSearchQuery(`spotify:track:${id}`), { type: "track_link", track_id: id });
  assert.deepEqual(parseSearchQuery(`https://open.spotify.com/intl-ru/track/${id}?si=xyz`), {
    type: "track_link",
    track_id: id,
  });
});

test("ссылка на альбом → album_link", () => {
  const id = "6TJmQnO44YE5BtTxH8pop1";
  assert.deepEqual(parseSearchQuery(`https://open.spotify.com/album/${id}`), {
    type: "album_link",
    album_id: id,
  });
  // трек внутри альбома-ссылки: track_link выигрывает (проверяется первым)
  const tid = "4iV5W9uYEdYUVa79Axb7Rh";
  assert.equal(parseSearchQuery(`https://open.spotify.com/track/${tid}`).type, "track_link");
});

test("ссылка на плейлист → playlist_link (owner пустой у Spotify)", () => {
  const id = "37i9dQZF1DXcBWIGoYBM5M";
  assert.deepEqual(parseSearchQuery(`https://open.spotify.com/playlist/${id}`), {
    type: "playlist_link",
    owner: "",
    kind: id,
  });
});

test("произвольный текст → search", () => {
  assert.deepEqual(parseSearchQuery("smells like teen spirit"), {
    type: "search",
    content: "smells like teen spirit",
  });
});
