import { test } from "node:test";
import assert from "node:assert/strict";
import { plural, pluralTracks } from "../src/infra/text.ts";

test("plural — русские правила", () => {
  assert.equal(pluralTracks(1), "1 трек");
  assert.equal(pluralTracks(3), "3 трека");
  assert.equal(pluralTracks(5), "5 треков");
  assert.equal(pluralTracks(11), "11 треков");
  assert.equal(pluralTracks(21), "21 трек");
  assert.equal(pluralTracks(22), "22 трека");
  assert.equal(pluralTracks(112), "112 треков");
  assert.equal(plural(101, "файл", "файла", "файлов"), "101 файл");
});
