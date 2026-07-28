import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSearchQuery } from "../src/infra/parsers.ts";

test("пустой запрос → empty", () => {
  assert.deepEqual(parseSearchQuery(""), { type: "empty" });
  assert.deepEqual(parseSearchQuery("   "), { type: "empty" });
});

test("ссылка на трек → track_link", () => {
  assert.deepEqual(
    parseSearchQuery("https://music.yandex.ru/album/123/track/456"),
    { type: "track_link", track_id: 456 },
  );
  assert.deepEqual(
    parseSearchQuery("music.yandex/album/1/track/2"),
    { type: "track_link", track_id: 2 },
  );
  assert.deepEqual(
    parseSearchQuery("https://yandex.ru/music/album/10/track/20"),
    { type: "track_link", track_id: 20 },
  );
});

test("ссылка на альбом → album_link (lookahead отделяет от /track)", () => {
  assert.deepEqual(
    parseSearchQuery("https://music.yandex.ru/album/789"),
    { type: "album_link", album_id: 789 },
  );
  // с /track это всё-таки трек, не альбом
  assert.equal(parseSearchQuery("music.yandex.ru/album/789/track/1").type, "track_link");
});

test("произвольный текст → search", () => {
  assert.deepEqual(parseSearchQuery("nirvana smells like"), {
    type: "search",
    content: "nirvana smells like",
  });
});
