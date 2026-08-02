import assert from "node:assert/strict";
import { test } from "node:test";
import { counterSnapshot, incCounter } from "../src/infra/metrics.ts";

test("incCounter: накапливает, snapshot отражает текущее состояние", () => {
  const name = `test_counter_${Date.now()}`;
  assert.equal(counterSnapshot().get(name), undefined);
  incCounter(name);
  incCounter(name, 4);
  assert.equal(counterSnapshot().get(name), 5);
});
