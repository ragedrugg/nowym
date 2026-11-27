/** «карточка»/«что играет» из меню: тост сразу, долгая работа — вне лока morda. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DialogState } from "@yaebal/morda";
import { createTestEnv } from "@yaebal/test";
import { MemoryStorage } from "yaebal";
import { buildBot } from "../src/bot/app.ts";
import type { Container } from "../src/bot/container.ts";
import { MENU_BTN, TOAST_DRAWING_CARD } from "../src/bot/texts.ts";

const dlgData = (env: ReturnType<typeof createTestEnv>, label: string): string => {
  const msg = env.lastBotMessage({ withReplyMarkup: true })!;
  const kb = (msg.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] }).inline_keyboard;
  const btn = kb.flat().find((b) => b.text.includes(label));
  assert.ok(btn?.callback_data, `кнопка «${label}»`);
  return btn.callback_data;
};

const timeout = (ms: number) => new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms).unref());

test("«карточка»: клик отвечает тостом и отпускает лок, пока работа ещё идёт", async () => {
  let release!: (token: string | null) => void;
  const hung = new Promise<string | null>((r) => {
    release = r;
  });
  let resolveCalls = 0;
  const container = {
    botUsername: "nowymbot",
    usersDb: { getToken: async () => "tok" }, // залогинен — в меню есть «карточка»
    knownChatsDb: null,
    downloadLimiter: { check: () => [true, 0] },
    getUserSettings: async () => ({}),
    resolveToken: () => {
      resolveCalls++;
      return hung; // Яндекс «висит»
    },
  } as unknown as Container;
  const offline = (async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))) as typeof fetch;
  const bot = buildBot({ token: "1:test", container, dialogStorage: new MemoryStorage<DialogState>(), fetch: offline });
  bot.onError((e) => {
    throw e;
  });
  const env = createTestEnv(bot);
  const user = env.createUser();
  await user.sendCommand("start");
  const menu = env.lastBotMessage({ withReplyMarkup: true })!;
  const card = dlgData(env, MENU_BTN.card);
  const help = dlgData(env, MENU_BTN.help);

  env.clearApiCalls();
  assert.notEqual(await Promise.race([user.click(card, menu), timeout(2000)]), "timeout", "клик не ждёт работу");
  assert.equal(resolveCalls, 1, "работа запущена");
  const answers = env.callsTo("answerCallbackQuery");
  assert.equal(answers.length, 1);
  assert.equal(answers[0]!.params?.text, TOAST_DRAWING_CARD);

  // следующий клик того же чата не стоит за висящей работой
  assert.notEqual(await Promise.race([user.click(help, menu), timeout(2000)]), "timeout", "лок чата свободен");
  assert.ok(env.lastApiCall("editMessageText"), "окно «что умею» отрисовано");

  release(null); // работа доходит до конца и сама отвечает в чат
  await new Promise((r) => setImmediate(r));
  env.shutdown();
});
