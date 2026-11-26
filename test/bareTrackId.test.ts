/** bareTrackId: null/undefined не превращаются в строки "null"/"undefined". */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { bareTrackId } from "../src/yandex/metadata.ts";

test("bareTrackId: составной и числовой id", () => {
  assert.equal(bareTrackId("123:456"), "123");
  assert.equal(bareTrackId(42), "42");
});

test("bareTrackId: null/undefined → пустая строка", () => {
  assert.equal(bareTrackId(undefined), "");
  assert.equal(bareTrackId(null), "");
});
