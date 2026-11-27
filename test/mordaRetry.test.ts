/** Узкий ретрай вызовов morda: 429/5xx/сеть не превращают правку меню в delete+resend. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DialogState } from "@yaebal/morda";
import { createTestEnv, TestApiError } from "@yaebal/test";
import { type Api, type Context, HttpError, MemoryStorage, TelegramError } from "yaebal";
import { buildBot } from "../src/bot/app.ts";
import type { Container } from "../src/bot/container.ts";
import { mordaRetry, retryingApi, TRANSIENT_DELAY_MS } from "../src/bot/mordaRetry.ts";
import { MENU_BTN } from "../src/bot/texts.ts";

/** api, чей call отдаёт заранее заданные исходы по очереди. */
function scriptedApi(outcomes: unknown[]) {
  const calls: string[] = [];
  const api = {
    call: async (method: string) => {
      calls.push(method);
      const o = outcomes.shift();
      if (o instanceof Error) throw o;
      return o;
    },
    sendMessage: async () => "direct",
  } as unknown as Api;
  return { api, calls };
}

function sleeps() {
  const waited: number[] = [];
  return { waited, sleep: async (ms: number) => void waited.push(ms) };
}

test("429 с retry_after: один повтор после паузы retry_after", async () => {
  const { api, calls } = scriptedApi([new TelegramError("editMessageText", 429, "Too Many", { retry_after: 3 }), "ok"]);
  const s = sleeps();
  assert.equal(await retryingApi(api, s.sleep).call("editMessageText", {}), "ok");
  assert.deepEqual(calls, ["editMessageText", "editMessageText"]);
  assert.deepEqual(s.waited, [3000]);
});

test("5xx, HttpError 502 и сетевая ошибка — один повтор; вторая неудача пробрасывается", async () => {
  for (const err of [
    new TelegramError("sendMessage", 502, "Bad Gateway"),
    new HttpError("sendMessage", 502, "Bad Gateway"),
    new TypeError("fetch failed"),
  ]) {
    const { api, calls } = scriptedApi([err, err]);
    const s = sleeps();
    await assert.rejects(retryingApi(api, s.sleep).call("sendMessage", {}), (e) => e === err);
    assert.equal(calls.length, 2);
    assert.deepEqual(s.waited, [TRANSIENT_DELAY_MS]);
  }
});

test("4xx, слишком длинный retry_after, abort и не-morda методы — без повтора", async () => {
  const cases: [string, Error][] = [
    ["editMessageText", new TelegramError("editMessageText", 400, "message to edit not found")],
    ["editMessageText", new TelegramError("editMessageText", 429, "Too Many", { retry_after: 600 })],
    ["deleteMessage", Object.assign(new Error("aborted"), { name: "AbortError" })],
    ["answerCallbackQuery", new TelegramError("answerCallbackQuery", 502, "Bad Gateway")],
  ];
  for (const [method, err] of cases) {
    const { api, calls } = scriptedApi([err, "ok"]);
    const s = sleeps();
    await assert.rejects(retryingApi(api, s.sleep).call(method, {}), (e) => e === err);
    assert.equal(calls.length, 1, method);
    assert.deepEqual(s.waited, []);
  }
});

test("обёртка перехватывает только call; остальные методы — исходного api", async () => {
  const { api } = scriptedApi([]);
  assert.equal(await retryingApi(api).sendMessage({} as never), "direct");
});

test("ctx.api подменяется только между before и after (хендлеры после morda видят исходный)", async () => {
  const orig = scriptedApi([]).api;
  const ctx = { api: orig } as unknown as Context;
  const seen: Api[] = [];
  const { before, after } = mordaRetry();
  await before(ctx, async () => {
    seen.push(ctx.api); // morda
    await after(ctx, async () => void seen.push(ctx.api)); // хендлеры после плагина
  });
  assert.notEqual(seen[0], orig);
  assert.equal(seen[1], orig);
  assert.equal(ctx.api, orig);
});

// ---------- на настоящем боте с morda ----------

function menuBot() {
  const container = {
    botUsername: "nowymbot",
    usersDb: { getToken: async () => null },
    knownChatsDb: null,
  } as unknown as Container;
  const offline = (async () => new Response(JSON.stringify({ ok: true, result: true }))) as typeof fetch;
  const bot = buildBot({
    token: "1:test",
    container,
    dialogStorage: new MemoryStorage<DialogState>(),
    fetch: offline,
  });
  bot.onError((e) => {
    throw e;
  });
  return bot;
}

const helpData = (env: ReturnType<typeof createTestEnv>): string => {
  const msg = env.lastBotMessage({ withReplyMarkup: true })!;
  const kb = (msg.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] }).inline_keyboard;
  return String(kb.flat().find((b) => b.text.includes(MENU_BTN.help))?.callback_data);
};

test("меню: 429 на правке — повтор правки, меню не удаляется и не пересылается", async () => {
  const env = createTestEnv(menuBot());
  const user = env.createUser();
  await user.sendCommand("start");
  const menu = env.lastBotMessage({ withReplyMarkup: true })!;
  env.onApi("editMessageText", new TestApiError("editMessageText", 429, "Too Many", { retry_after: 0 }), {
    times: 1,
  });
  await user.click(helpData(env), menu);
  assert.equal(env.callsTo("editMessageText").length, 2);
  assert.equal(env.callsTo("deleteMessage").length, 0);
  assert.equal(env.callsTo("sendMessage").length, 1, "только исходное меню");
  env.shutdown();
});

test("меню: 400 на правке — как раньше, morda удаляет и шлёт заново (ретрай не мешает)", async () => {
  const env = createTestEnv(menuBot());
  const user = env.createUser();
  await user.sendCommand("start");
  const menu = env.lastBotMessage({ withReplyMarkup: true })!;
  env.onApi("editMessageText", new TestApiError("editMessageText", 400, "message can't be edited"), { times: 1 });
  await user.click(helpData(env), menu);
  assert.equal(env.callsTo("editMessageText").length, 1);
  assert.equal(env.callsTo("deleteMessage").length, 1);
  assert.equal(env.callsTo("sendMessage").length, 2);
  env.shutdown();
});
