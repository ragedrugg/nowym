// RESULT_ID_DUPLICATE: Telegram отвергает весь answerInlineQuery, если в нём два результата с одним id
import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeResultsById } from "../src/bot/handlers/inline.ts";

test("dedupeResultsById: оставляет первый экземпляр и порядок, не трогает результаты без строкового id", () => {
  const a = { id: "tm:1", n: "текущий" };
  const dup = { id: "tm:1", n: "из недавнего" };
  const b = { id: "tm:2" };
  const noId = { title: "x" };
  assert.deepEqual(dedupeResultsById([a, b, dup, noId]), [a, b, noId]);
  assert.deepEqual(dedupeResultsById([]), []);
});
