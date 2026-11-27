/** R4: CardRenderPool — ленивый spawn, idle-terminate, повторный подъём после простоя. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { RenderCardArgs } from "../src/services/card/index.ts";
import { CardRenderPool } from "../src/services/cardRenderPool.ts";

const workerUrl = new URL("./fixtures/echoRenderWorker.ts", import.meta.url);
const job = (n: number, delayMs = 0) => ({ n, delayMs }) as unknown as RenderCardArgs;

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await delay(10);
  }
}

test("R4: воркеры не поднимаются до первого рендера", async () => {
  const pool = new CardRenderPool({ size: 2, workerUrl });
  pool.start();
  assert.equal(pool.workerCount, 0);
  const buf = await pool.render(job(7));
  assert.deepEqual([...buf], [7]);
  assert.equal(pool.workerCount, 1, "один рендер — один воркер");
  await pool.stop();
  assert.equal(pool.workerCount, 0);
});

test("R4: параллельные рендеры поднимают не больше size воркеров", async () => {
  const pool = new CardRenderPool({ size: 2, workerUrl });
  pool.start();
  const bufs = await Promise.all([1, 2, 3, 4].map((n) => pool.render(job(n, 30))));
  assert.deepEqual(
    bufs.map((b) => b[0]),
    [1, 2, 3, 4],
  );
  assert.equal(pool.workerCount, 2);
  await pool.stop();
});

test("R4: простой дольше idleMs гасит воркеры, следующий рендер поднимает заново", async () => {
  const pool = new CardRenderPool({ size: 2, idleMs: 50, workerUrl });
  pool.start();
  await Promise.all([pool.render(job(1, 20)), pool.render(job(2, 20))]);
  assert.equal(pool.workerCount, 2);
  await until(() => pool.workerCount === 0);
  const buf = await pool.render(job(9));
  assert.deepEqual([...buf], [9]);
  assert.equal(pool.workerCount, 1);
  await pool.stop();
});

test("R4: занятый воркер не гасится по idle-таймеру", async () => {
  const pool = new CardRenderPool({ size: 1, idleMs: 40, workerUrl });
  pool.start();
  await pool.render(job(1));
  const long = pool.render(job(2, 150));
  await delay(100);
  assert.equal(pool.workerCount, 1, "рендер в полёте — воркер жив");
  assert.deepEqual([...(await long)], [2]);
  await pool.stop();
});

test("R4: после stop render отклоняется", async () => {
  const pool = new CardRenderPool({ size: 1, workerUrl });
  pool.start();
  await pool.stop();
  await assert.rejects(pool.render(job(1)), /stopped/);
});
