/** Чистая FSM-логика BroadcastService (без реального Telegram/Postgres) +
 * run() на стаб-боте: проверяем разделение sent/failed/blocked и чистку
 * known_chats при недоступном получателе. */

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Bot } from "gramio";
import { BroadcastService } from "../src/services/broadcast.ts";
import type { KnownChatsDb } from "../src/storage/knownChats.ts";

function mkKnownChatsDb(chatIds: number[]): { db: KnownChatsDb; removed: number[] } {
  const removed: number[] = [];
  const db = {
    allChatIds: async () => chatIds,
    remove: async (chatId: number) => {
      removed.push(chatId);
    },
    count: async () => chatIds.length,
    touch: async () => {},
    initSchema: async () => {},
  };
  return { db: db as unknown as KnownChatsDb, removed };
}

function mkBot(copyMessage: (params: { chat_id: number }) => Promise<unknown>): Bot {
  return { api: { copyMessage } } as unknown as Bot;
}

test("startCompose → captureContent → pendingConfirm — счастливый путь", () => {
  const { db } = mkKnownChatsDb([]);
  const svc = new BroadcastService(
    db,
    mkBot(async () => ({})),
  );

  assert.equal(svc.isAwaitingContent(1), false);
  svc.startCompose(1);
  assert.equal(svc.isAwaitingContent(1), true);

  const captured = svc.captureContent(1, /* fromChatId */ 1, /* messageId */ 42);
  assert.equal(captured, true);
  assert.equal(svc.isAwaitingContent(1), false); // ушли в confirm
  assert.deepEqual(svc.pendingConfirm(1), { fromChatId: 1, messageId: 42 });
});

test("captureContent без startCompose — не в режиме ожидания, возвращает false", () => {
  const { db } = mkKnownChatsDb([]);
  const svc = new BroadcastService(
    db,
    mkBot(async () => ({})),
  );
  assert.equal(svc.captureContent(1, 1, 42), false);
  assert.equal(svc.pendingConfirm(1), null);
});

test("cancelCompose очищает черновик (awaiting и confirm), но не мешает разным админам", () => {
  const { db } = mkKnownChatsDb([]);
  const svc = new BroadcastService(
    db,
    mkBot(async () => ({})),
  );

  svc.startCompose(1);
  assert.equal(svc.cancelCompose(1), true);
  assert.equal(svc.isAwaitingContent(1), false);

  svc.startCompose(2);
  svc.captureContent(2, 2, 7);
  assert.equal(svc.cancelCompose(2), true);
  assert.equal(svc.pendingConfirm(2), null);
});

test("beginSending — второй тап на confirm получает null (защита от дабл-клика)", () => {
  const { db } = mkKnownChatsDb([]);
  const svc = new BroadcastService(
    db,
    mkBot(async () => ({})),
  );

  svc.startCompose(1);
  svc.captureContent(1, 5, 99);

  const first = svc.beginSending(1);
  assert.deepEqual(first, { fromChatId: 5, messageId: 99 });

  const second = svc.beginSending(1);
  assert.equal(second, null);
});

test("requestStop — работает только на стадии sending", () => {
  const { db } = mkKnownChatsDb([]);
  const svc = new BroadcastService(
    db,
    mkBot(async () => ({})),
  );

  assert.equal(svc.requestStop(1), false); // нет состояния вовсе

  svc.startCompose(1);
  assert.equal(svc.requestStop(1), false); // awaiting_content, не sending

  svc.captureContent(1, 1, 1);
  assert.equal(svc.requestStop(1), false); // confirm, ещё не sending

  svc.beginSending(1);
  assert.equal(svc.requestStop(1), true); // теперь sending
});

test("черновик протухает по TTL — captureContent после 10+ минут не подхватывает", () => {
  mock.timers.enable({ apis: ["Date"] });
  try {
    const { db } = mkKnownChatsDb([]);
    const svc = new BroadcastService(
      db,
      mkBot(async () => ({})),
    );
    svc.startCompose(1);
    mock.timers.tick(600_001); // COMPOSE_TTL_MS + 1мс
    assert.equal(svc.isAwaitingContent(1), false);
    assert.equal(svc.captureContent(1, 1, 1), false);
  } finally {
    mock.timers.reset();
  }
});

test("run() — считает sent/failed/blocked раздельно и чистит known_chats у заблокировавших", async () => {
  const { db, removed } = mkKnownChatsDb([100, 200, 300]);
  const bot = mkBot(async ({ chat_id }) => {
    if (chat_id === 100) return {}; // ok
    if (chat_id === 200) {
      const e = new Error("Forbidden: bot was blocked by the user");
      (e as { code?: number }).code = 403;
      throw e;
    }
    throw new Error("network hiccup"); // 300 — временный сбой, не блок
  });
  const svc = new BroadcastService(db, bot);

  svc.startCompose(1);
  svc.captureContent(1, 1, 1);
  const pending = svc.beginSending(1)!;

  const progressCalls: Array<{ sent: number; failed: number; blocked: number }> = [];
  const result = await svc.run(1, pending.fromChatId, pending.messageId, async (r) => {
    progressCalls.push({ sent: r.sent, failed: r.failed, blocked: r.blocked });
  });

  assert.equal(result.total, 3);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.blocked, 1);
  assert.deepEqual(removed, [200]); // только заблокировавший вычищен
  assert.ok(progressCalls.length > 0); // финальный прогресс отрендерен хотя бы раз
  assert.equal(svc.requestStop(1), false); // run() сам очистил state админа
});
