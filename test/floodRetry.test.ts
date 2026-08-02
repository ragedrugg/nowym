/** floodRetry — регрессия на `retry_after === 0`.
 *
 * В коде явно оговорено: `!retryAfter` тут неверен, потому что 0 — валидный
 * сигнал «ретрай прямо сейчас», а не признак «это не 429». Тесты ниже падают,
 * если проверку «упростят» обратно на truthy. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { floodRetry } from "../src/infra/floodRetry.ts";

/** ошибка GramIO вида 429 с управляемым retry_after. */
const flood = (retryAfter: number): Error =>
  Object.assign(new Error("Too Many Requests: 429"), { payload: { retry_after: retryAfter } });

test("floodRetry: retry_after=0 — это ретрай, а не «не 429»", async () => {
  const seen: number[] = [];
  let calls = 0;

  const res = await floodRetry(
    async () => {
      calls += 1;
      if (calls === 1) throw flood(0);
      return "ok";
    },
    { onWait: (retryAfter) => seen.push(retryAfter) },
  );

  assert.equal(res, "ok");
  assert.equal(calls, 2, "с `!retryAfter` ошибка улетела бы наружу на первой же попытке");
  assert.deepEqual(seen, [0], "ожидание должно было отработать именно с retryAfter=0");
});

test("floodRetry: ошибка без retry_after — не ретраится, пробрасывается как есть", async () => {
  let calls = 0;

  await assert.rejects(
    floodRetry(async () => {
      calls += 1;
      throw new Error("boom");
    }),
    /boom/,
  );

  assert.equal(calls, 1, "не-429 не должен уходить в цикл повторов (по умолчанию attempts=Infinity)");
});

test("floodRetry: attempts исчерпаны — последняя 429 пробрасывается", async () => {
  let calls = 0;

  await assert.rejects(
    floodRetry(
      async () => {
        calls += 1;
        throw flood(0);
      },
      { attempts: 3 },
    ),
    /429/,
  );

  assert.equal(calls, 3);
});
