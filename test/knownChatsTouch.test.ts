/** R3: KnownChatsDb.touch — UPSERT не чаще раза в 6ч на чат (fake pool, без БД). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { KnownChatsDb } from "../src/storage/knownChats.ts";
import { usersPool } from "../src/storage/pool.ts";

const H = 3600_000;

function fakePool(t: { mock: { method: (...a: never[]) => unknown } }, fail: () => boolean = () => false): string[] {
  const sqls: string[] = [];
  (t.mock.method as (o: object, m: string, f: unknown) => unknown)(usersPool, "query", async (sql: string) => {
    sqls.push(sql);
    if (fail()) throw new Error("pg down");
    return { rows: [], rowCount: 0 };
  });
  return sqls;
}

const upserts = (sqls: string[]) => sqls.filter((s) => s.includes("INSERT INTO known_chats")).length;

test("R3: повторный touch в пределах 6ч не пишет в БД, после — пишет", async (t) => {
  const sqls = fakePool(t);
  let now = 1_000_000;
  const db = new KnownChatsDb(() => now);
  await db.touch(1);
  await db.touch(1);
  now += 5 * H;
  await db.touch(1);
  assert.equal(upserts(sqls), 1);
  await db.touch(2);
  assert.equal(upserts(sqls), 2, "другой чат пишется сразу");
  now += 1 * H + 1;
  await db.touch(1);
  assert.equal(upserts(sqls), 3);
});

test("R3: сбой UPSERT не ставит метку — следующий touch пробует снова", async (t) => {
  let failing = true;
  const sqls = fakePool(t, () => failing);
  const db = new KnownChatsDb(() => 0);
  await assert.rejects(db.touch(1), /pg down/);
  failing = false;
  await db.touch(1);
  assert.equal(upserts(sqls), 2);
});

test("R3: remove сбрасывает метку — вернувшийся чат пишется сразу", async (t) => {
  const sqls = fakePool(t);
  const db = new KnownChatsDb(() => 0);
  await db.touch(1);
  await db.remove(1);
  await db.touch(1);
  assert.equal(upserts(sqls), 2);
});
