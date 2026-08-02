/** safeApi — единые безопасные обёртки над bot.api (дедуп safeEdit/say/editOrSend). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Bot } from "gramio";
import { editOrSend, safeAnswerCb, safeEditApi, safeEditMedia, say } from "../src/bot/safeApi.ts";

type Call = { method: string; params: unknown };

/** мини-стаб бота: пишет вызовы api в массив, опционально бросает заданную ошибку. */
function stubBot(throwers: Record<string, Error> = {}): { bot: Bot; calls: Call[] } {
  const calls: Call[] = [];
  const make =
    (name: string) =>
    async (params: unknown): Promise<unknown> => {
      calls.push({ method: name, params });
      const err = throwers[name];
      if (err) throw err;
      return {};
    };
  const bot = {
    api: {
      editMessageText: make("editMessageText"),
      sendMessage: make("sendMessage"),
      editMessageMedia: make("editMessageMedia"),
      editMessageReplyMarkup: make("editMessageReplyMarkup"),
    },
  } as unknown as Bot;
  return { bot, calls };
}

test("safeEditApi: глотает 'not modified' без throw", async () => {
  const { bot, calls } = stubBot({ editMessageText: new Error("Bad Request: message is not modified") });
  await safeEditApi(bot, { chatId: 1, messageId: 2 }, "x");
  assert.equal(calls.length, 1);
});

test("safeEditApi: не бросает и на прочих ошибках (best-effort)", async () => {
  const { bot } = stubBot({ editMessageText: new Error("boom") });
  await safeEditApi(bot, { inlineMessageId: "abc" }, "x");
  assert.ok(true);
});

test("editOrSend: при провале edit шлёт новое сообщение", async () => {
  const { bot, calls } = stubBot({ editMessageText: new Error("message to edit not found") });
  await editOrSend(bot, { chatId: 1, messageId: 2 }, "hi");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["editMessageText", "sendMessage"],
  );
});

test("safeEditMedia: глотает 'not modified'", async () => {
  const { bot } = stubBot({ editMessageMedia: new Error("message is not modified") });
  await safeEditMedia(bot, { inlineMessageId: "m" }, { type: "audio" });
  assert.ok(true);
});

test("safeEditMedia: пробрасывает прочие ошибки наверх", async () => {
  const { bot } = stubBot({ editMessageMedia: new Error("network down") });
  await assert.rejects(() => safeEditMedia(bot, { inlineMessageId: "m" }, {}), /network down/);
});

test("say: правит статус-сообщение, если есть id", async () => {
  const { bot, calls } = stubBot();
  await say(bot, 1, 99, "txt");
  assert.equal(calls[0]!.method, "editMessageText");
});

test("say: без статуса шлёт новое сообщение", async () => {
  const { bot, calls } = stubBot();
  await say(bot, 1, null, "txt");
  assert.equal(calls[0]!.method, "sendMessage");
});

test("say: при провале edit фолбэчит на sendMessage", async () => {
  const { bot, calls } = stubBot({ editMessageText: new Error("nope") });
  await say(bot, 1, 5, "txt");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["editMessageText", "sendMessage"],
  );
});

test("safeAnswerCb: глотает throw на протухшем query", async () => {
  await safeAnswerCb({
    answer: async () => {
      throw new Error("query is too old");
    },
  });
  assert.ok(true);
});
