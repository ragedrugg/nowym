/** R6: UsersDb.get — 60с кэш расшифрованных creds, save/delete сбрасывают сразу (fake pool). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { crypto } from "../src/infra/crypto.ts";
import { usersPool } from "../src/storage/pool.ts";
import { UsersDb } from "../src/storage/users.ts";

type Row = { access_token: string; refresh_token: string | null; expires_at: number | null };

function fakePool(t: { mock: { method: (...a: never[]) => unknown } }, table: Map<number, Row>, hold?: Promise<void>) {
  const selects: number[] = [];
  (t.mock.method as (o: object, m: string, f: unknown) => unknown)(
    usersPool,
    "query",
    async (sql: string, params: unknown[]) => {
      const uid = params[0] as number;
      if (sql.startsWith("SELECT")) {
        selects.push(uid);
        const row = table.get(uid);
        if (hold) await hold;
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes("INSERT")) {
        table.set(uid, { access_token: params[1] as string, refresh_token: params[2] as string, expires_at: null });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("DELETE")) return { rows: [], rowCount: table.delete(uid) ? 1 : 0 };
      throw new Error(`unexpected sql ${sql}`);
    },
  );
  return selects;
}

crypto.init(Buffer.alloc(32, 7).toString("base64url"));
const enc = (s: string) => crypto.encrypt(s) as string;

test("R6: повторный get в пределах 60с не ходит в БД, после — ходит", async (t) => {
  const table = new Map<number, Row>([[1, { access_token: enc("A"), refresh_token: null, expires_at: null }]]);
  const selects = fakePool(t, table);
  let now = 0;
  const db = new UsersDb(() => now);
  assert.equal((await db.get(1))?.access_token, "A");
  assert.equal((await db.get(1))?.access_token, "A");
  assert.equal(selects.length, 1);
  now += 60_001;
  await db.get(1);
  assert.equal(selects.length, 2);
});

test("R6: save и delete сбрасывают кэш сразу (новый токен / logout видны без ожидания)", async (t) => {
  const table = new Map<number, Row>([[1, { access_token: enc("OLD"), refresh_token: null, expires_at: null }]]);
  fakePool(t, table);
  const db = new UsersDb(() => 0);
  assert.equal((await db.get(1))?.access_token, "OLD");
  await db.save(1, "NEW");
  assert.equal((await db.get(1))?.access_token, "NEW");
  await db.delete(1);
  assert.equal(await db.get(1), null);
});

test("R6: медленный get, начавшийся до save, не кладёт в кэш старые creds", async (t) => {
  const table = new Map<number, Row>([[1, { access_token: enc("OLD"), refresh_token: null, expires_at: null }]]);
  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  fakePool(t, table, hold);
  const db = new UsersDb(() => 0);
  const inflight = db.get(1); // SELECT прочитал OLD и ждёт
  await new Promise((r) => setImmediate(r));
  await db.save(1, "NEW"); // запись целиком прошла, пока медленный SELECT ещё в полёте
  release();
  assert.equal((await inflight)?.access_token, "OLD");
  assert.equal((await db.get(1))?.access_token, "NEW");
});

test("R6: мутация возвращённого объекта не портит кэш", async (t) => {
  const table = new Map<number, Row>([[1, { access_token: enc("A"), refresh_token: null, expires_at: null }]]);
  fakePool(t, table);
  const db = new UsersDb(() => 0);
  const c = await db.get(1);
  c!.access_token = "MUT";
  assert.equal((await db.get(1))?.access_token, "A");
});
