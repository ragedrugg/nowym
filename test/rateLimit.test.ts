import assert from "node:assert/strict";
import { test } from "node:test";
import { TokenBucket, UserRateLimiter } from "../src/infra/rateLimit.ts";

test("bucket — расход и отказ при пустом", () => {
  const b = new TokenBucket(3, 3, 0); // refill 0 → не доливается
  assert.equal(b.consume(), true);
  assert.equal(b.consume(), true);
  assert.equal(b.consume(), true);
  assert.equal(b.consume(), false);
  assert.ok(b.secondsUntilAvailable() === Infinity || b.secondsUntilAvailable() > 0);
});

test("limiter — первый запрос разрешён, исчерпание даёт retry_after", () => {
  const lim = new UserRateLimiter(2, 0); // 2 токена, без долива
  assert.deepEqual(lim.check(1), [true, 0]);
  assert.deepEqual(lim.check(1), [true, 0]);
  const [allowed, retry] = lim.check(1);
  assert.equal(allowed, false);
  assert.ok(retry > 0 || retry === Infinity);
  // другой юзер — свой bucket
  assert.deepEqual(lim.check(2), [true, 0]);
});

test("refill во времени", async () => {
  const lim = new UserRateLimiter(1, 100); // быстрый долив
  assert.equal(lim.check(1)[0], true);
  assert.equal(lim.check(1)[0], false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(lim.check(1)[0], true); // долилось
});
