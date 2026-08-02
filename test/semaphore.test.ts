/** Semaphore — прямая передача permit ожидающему и защита от лишнего release. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Semaphore } from "../src/infra/semaphore.ts";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** зарезолвился ли промис к следующему тику (без вечного ожидания на блокирующем acquire). */
const settled = (p: Promise<unknown>): Promise<boolean> => Promise.race([p.then(() => true), tick().then(() => false)]);

test("Semaphore: release при живом ожидающем отдаёт permit ему напрямую, а не в общий пул", async () => {
  const s = new Semaphore(1);
  await s.acquire(); // единственный permit занят

  const waiter = s.acquire();
  assert.equal(await settled(waiter), false, "второй acquire обязан блокироваться");

  s.release();
  assert.equal(await settled(waiter), true, "ожидающий должен разблокироваться");

  // permit ушёл ожидающему напрямую — в пул ничего не вернулось, следующий снова ждёт
  const third = s.acquire();
  assert.equal(await settled(third), false, "permit не должен был осесть в пуле");

  s.release();
  assert.equal(await settled(third), true);
});

test("Semaphore: лишний release без парного acquire не пробивает потолок", async () => {
  const s = new Semaphore(2);
  s.release();
  s.release();
  s.release(); // три release подряд, ни одного acquire

  await s.acquire();
  await s.acquire();

  const third = s.acquire();
  assert.equal(await settled(third), false, "потолок остался 2, а не вырос до 5");

  s.release();
  assert.equal(await settled(third), true);
});

test("Semaphore: двойной release() подряд, пока есть живой ожидающий, не создаёт фантомный permit", async () => {
  const s = new Semaphore(1);
  await s.acquire(); // A держит единственный permit

  const b = s.acquire();
  assert.equal(await settled(b), false, "B обязан блокироваться — свободных permits нет");

  // реалистичный баг вызывающего кода: release() дважды подряд синхронно
  // (напр. и в finally, и явно раньше). Второй — лишний, без парного acquire.
  s.release(); // легитимный release A — должен уйти напрямую B
  s.release(); // лишний — outstanding в этот момент ещё не увеличен B (микротаска не успела)

  assert.equal(await settled(b), true, "B должен был получить permit");

  // если бы лишний release создал фантомный permit, C прошёл бы сразу же
  const c = s.acquire();
  assert.equal(await settled(c), false, "потолок 1 не должен был вырасти — C обязан ждать");

  s.release(); // теперь настоящий release B
  assert.equal(await settled(c), true);
});
