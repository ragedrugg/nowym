/** rich_messages: колонка, чтение, сеттер (fake pool, без БД). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { usersPool } from "../src/storage/pool.ts";
import { DEFAULT_RICH_MESSAGES, SettingsDb } from "../src/storage/settings.ts";

type Call = { sql: string; params: unknown[] | undefined };

function fakeQuery(t: { mock: { method: (...a: never[]) => unknown } }, rows: Record<string, unknown>[]): Call[] {
  const calls: Call[] = [];
  (t.mock.method as (o: object, m: string, f: unknown) => unknown)(
    usersPool,
    "query",
    async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
  );
  return calls;
}

const BASE_ROW = {
  track_layout: "button",
  track_send_mode: "text_media",
  track_quality: "best",
  card_style: "ambient",
  card_layout: "button",
  card_progress: "wavy",
  card_aspect: "16:9",
  card_show_album: true,
  card_show_type: false,
  card_show_year: true,
  card_show_label: false,
  card_show_track_no: false,
  card_show_avatar: true,
};

test("DEFAULT_RICH_MESSAGES = false", () => {
  assert.equal(DEFAULT_RICH_MESSAGES, false);
});

test("initSchema: аддитивный ADD COLUMN IF NOT EXISTS rich_messages, без деструктивного DDL", async (t) => {
  const calls = fakeQuery(t as never, []);
  await new SettingsDb().initSchema();
  const alter = calls.filter((c) =>
    /ADD COLUMN IF NOT EXISTS rich_messages BOOLEAN NOT NULL DEFAULT FALSE/.test(c.sql),
  );
  assert.equal(alter.length, 1);
  assert.match(alter[0]?.sql ?? "", /ALTER TABLE user_settings/);
  for (const c of calls) assert.doesNotMatch(c.sql, /\b(DROP|TRUNCATE|DELETE)\b/i);
});

test("get: нет строки -> rich_messages false; прочие дефолты не изменились", async (t) => {
  fakeQuery(t as never, []);
  const s = await new SettingsDb().get(1);
  assert.equal(s.rich_messages, false);
  assert.equal(s.track_layout, "button");
  assert.equal(s.track_send_mode, "text_media");
  assert.equal(s.track_quality, "best");
  assert.equal(s.card_aspect, "16:9");
  assert.equal(s.card_toggles.album, true);
  assert.equal(s.card_toggles.type, false);
});

test("get: SELECT содержит rich_messages; true round-trip", async (t) => {
  const calls = fakeQuery(t as never, [{ ...BASE_ROW, rich_messages: true }]);
  const s = await new SettingsDb().get(1);
  assert.equal(s.rich_messages, true);
  assert.match(calls[0]?.sql ?? "", /rich_messages/);
  assert.deepEqual(calls[0]?.params, [1]);
});

test("get: rich_messages false/null/undefined -> false", async (t) => {
  for (const v of [false, null, undefined]) {
    fakeQuery(t as never, [{ ...BASE_ROW, rich_messages: v }]);
    assert.equal((await new SettingsDb().get(1)).rich_messages, false);
  }
});

test("setRichMessages: параметризованный UPSERT только колонки rich_messages", async (t) => {
  const calls = fakeQuery(t as never, []);
  const r = await new SettingsDb().setRichMessages(7, true);
  assert.equal(r, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /INSERT INTO user_settings \(user_id, rich_messages, updated_at\)/);
  assert.match(calls[0]?.sql ?? "", /rich_messages\s+= EXCLUDED\.rich_messages/);
  assert.doesNotMatch(calls[0]?.sql ?? "", /track_|card_/);
  assert.deepEqual(calls[0]?.params, [7, true]);
});

test("setRichMessages: не-true (мусор) сохраняется как false", async (t) => {
  const calls = fakeQuery(t as never, []);
  const db = new SettingsDb();
  assert.equal(await db.setRichMessages(1, "yes" as never), false);
  assert.equal(await db.setRichMessages(1, false), false);
  assert.deepEqual(
    calls.map((c) => c.params),
    [
      [1, false],
      [1, false],
    ],
  );
});
