/** AdminAlerter — троттленные алерты админу (#7). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AdminAlerter } from "../src/infra/adminAlerter.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("AdminAlerter: первый алерт уходит сразу", async () => {
  const sent: string[] = [];
  const a = new AdminAlerter(async (t) => void sent.push(t), 10_000);
  a.report("boom");
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /boom/);
});

test("AdminAlerter: повторные внутри cooldown придерживаются", async () => {
  const sent: string[] = [];
  const a = new AdminAlerter(async (t) => void sent.push(t), 10_000);
  a.report("e1");
  await tick();
  a.report("e2");
  a.report("e3");
  await tick();
  assert.equal(sent.length, 1); // только первый
});

test("AdminAlerter: cooldown=0 — шлёт каждый раз", async () => {
  const sent: string[] = [];
  const a = new AdminAlerter(async (t) => void sent.push(t), 0);
  a.report("x");
  await tick();
  a.report("y");
  await tick();
  assert.equal(sent.length, 2);
});

test("AdminAlerter: сбой send не роняет report", async () => {
  const a = new AdminAlerter(async () => {
    throw new Error("tg down");
  }, 0);
  a.report("z"); // не должно бросить
  await tick();
  assert.ok(true);
});
