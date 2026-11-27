import assert from "node:assert/strict";
import { test } from "node:test";
import { collectGarbage } from "../src/infra/gc.ts";

test("collectGarbage: зовёт globalThis.gc, если он есть, и молчит без него", () => {
  const g = globalThis as { gc?: () => void };
  const saved = g.gc;
  try {
    let calls = 0;
    g.gc = () => {
      calls++;
    };
    collectGarbage("test");
    assert.equal(calls, 1);
    g.gc = undefined;
    assert.doesNotThrow(() => collectGarbage("test"));
  } finally {
    g.gc = saved;
  }
});
