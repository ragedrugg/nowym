/** norm — нормализация значений настроек к whitelist/дефолту; форма дефолтов. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CARD_DEFAULT_TOGGLE,
  CARD_TOGGLES,
  DEFAULT_TRACK_LAYOUT,
  TRACK_LAYOUTS,
  TRACK_QUALITIES,
  norm,
} from "../src/storage/settings.ts";

test("norm: валидное значение проходит как есть", () => {
  assert.equal(norm("text", TRACK_LAYOUTS, DEFAULT_TRACK_LAYOUT), "text");
  assert.equal(norm("lossless", TRACK_QUALITIES, "best"), "lossless");
});

test("norm: невалидное/null/undefined → дефолт", () => {
  assert.equal(norm("ogg", TRACK_QUALITIES, "best"), "best");
  assert.equal(norm(null, TRACK_LAYOUTS, DEFAULT_TRACK_LAYOUT), "button");
  assert.equal(norm(undefined, TRACK_LAYOUTS, DEFAULT_TRACK_LAYOUT), "button");
  assert.equal(norm("", TRACK_LAYOUTS, DEFAULT_TRACK_LAYOUT), "button");
});

test("CARD_DEFAULT_TOGGLE: ключи совпадают с CARD_TOGGLES", () => {
  assert.deepEqual(Object.keys(CARD_DEFAULT_TOGGLE).sort(), [...CARD_TOGGLES].sort());
});
