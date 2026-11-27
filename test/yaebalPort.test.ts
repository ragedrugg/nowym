/** Риски порта GramIO → yaebal, проверенные на настоящем yaebal Bot (@yaebal/test перехватывает
 * все вызовы Bot API, сети нет):
 *  • ctx несёт сырые snake_case-поля (result_id, inline_message_id, from.first_name);
 *  • inline-ответы сохраняют is_personal/cache_time;
 *  • InlineKeyboard: pattern() раскладывает уже добавленные кнопки, декор-ключ — icon;
 *  • 429: retry_after — в TelegramError.parameters, повтор пересобирает multipart (аудио + обложка);
 *  • morda-меню: /start шлёт меню, навигация правит его на месте, старое меню отвечает «устарело»;
 *  • webhook: 200 уходит до конца обработки апдейта. */
import { strict as assert } from "node:assert";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { DialogState } from "@yaebal/morda";
import { createTestEnv } from "@yaebal/test";
import { Bot, type InlineKeyboard, MemoryStorage, TelegramError } from "yaebal";
import { apiRootOf, buildBot } from "../src/bot/app.ts";
import type { Container } from "../src/bot/container.ts";
import { registerInline } from "../src/bot/handlers/inline/index.ts";
import { resolveIconSet } from "../src/bot/iconSet.ts";
import {
  broadcastConfirmMarkup,
  cancelAlbumMarkup,
  nowPlayingMarkup,
  trackMarkup,
  yandexHealthMarkup,
} from "../src/bot/markup.ts";
import { ChannelSender } from "../src/bot/telegramSender.ts";
import { MENU_BTN, STALE_MENU } from "../src/bot/texts.ts";
import type { AppBot } from "../src/bot/types.ts";
import { createWebhookHandler } from "../src/infra/httpServer.ts";

/** вызовы, ушедшие мимо ctx.api прямо в bot.api (хендлеры nowym зовут bot.api.* — как при GramIO):
 * @yaebal/test подменяет только ctx.api, поэтому транспорт бота — фейковый fetch, сеть недоступна. */
type WireCall = { method: string; params: Record<string, unknown> };
function offlineFetch(calls: WireCall[]): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split("/").at(-1) ?? "";
    const params = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ method, params });
    return new Response(JSON.stringify({ ok: true, result: true }));
  }) as typeof fetch;
}

const quietBot = (calls: WireCall[] = []): AppBot => {
  const bot = new Bot("1:test", { fetch: offlineFetch(calls) }) as unknown as AppBot;
  bot.onError((e) => {
    throw e;
  });
  return bot;
};

const rows = (kb: InlineKeyboard): number[] => kb.build().inline_keyboard.map((r) => r.length);

// ---------- ctx: сырые поля Bot API ----------

test("inline_query: from/query/offset из сырого ctx; ответ сохраняет is_personal и cache_time", async () => {
  const seen: number[] = [];
  const container = {
    inlineLimiter: {
      check: (uid: number) => {
        seen.push(uid);
        return [false, 7] as [boolean, number]; // лимитер сработал — ответ без похода в Яндекс
      },
    },
  } as unknown as Container;
  const bot = quietBot();
  registerInline(bot, container);
  const env = createTestEnv(bot, { strictDispatch: true });
  const user = env.createUser({ firstName: "Аня", username: "anya" });
  await user.sendInlineQuery("hello", { offset: "" });
  assert.deepEqual(seen, [user.payload.id]);
  const call = env.lastApiCall("answerInlineQuery");
  assert.ok(call, "answerInlineQuery вызван");
  assert.equal(call.params?.is_personal, true);
  assert.equal(call.params?.cache_time, 3);
  assert.deepEqual(call.params?.results, []);
  env.shutdown();
});

test("chosen_inline_result: result_id и inline_message_id доходят из snake_case-полей", async () => {
  const owners = new Map<string, number>();
  const container = {
    inlineOwners: { set: (k: string, v: number) => owners.set(k, v), get: () => null },
    inlineEffects: { set: () => undefined },
    resolveToken: async () => null, // без токена — сразу «войди» на кнопке, без скачивания
  } as unknown as Container;
  const wire: WireCall[] = [];
  const bot = quietBot(wire);
  registerInline(bot, container);
  const env = createTestEnv(bot);
  const user = env.createUser();
  await user.chooseInlineResult("42", "song", { inlineMessageId: "IMSG-1" });
  assert.equal(owners.get("IMSG-1"), user.payload.id, "владелец инлайна запомнен по inline_message_id");
  const m = wire.findLast((c) => c.method === "editMessageReplyMarkup")?.params as
    | { inline_message_id?: string; reply_markup?: unknown }
    | undefined;
  assert.equal(m?.inline_message_id, "IMSG-1");
  assert.match(JSON.stringify(m?.reply_markup), /load:42/, "result_id → track 42");
  env.shutdown();
});

test("callback load: inline_message_id из сырого ctx — чужой тап получает «не твой трек», а не «найди заново»", async () => {
  const container = {
    botUsername: "nowymbot",
    inlineOwners: { get: () => 999, set: () => undefined },
  } as unknown as Container;
  const bot = quietBot();
  registerInline(bot, container);
  const env = createTestEnv(bot);
  const user = env.createUser();
  await env.dispatch({
    update_id: 1,
    callback_query: {
      id: "cb1",
      from: user.payload,
      chat_instance: "ci",
      inline_message_id: "IMSG-2",
      data: "load:42",
    },
  });
  const ans = env.lastApiCall("answerCallbackQuery");
  assert.equal(ans?.params?.show_alert, true);
  assert.match(String(ans?.params?.text), /nowymbot/, String(ans?.params?.text));
  env.shutdown();
});

// ---------- клавиатуры ----------

test("клавиатуры: pattern() после кнопок даёт те же ряды, что ленивый pattern GramIO", () => {
  assert.deepEqual(rows(trackMarkup(42, true)), [2], "♥ и «открыть» в одну линию");
  assert.deepEqual(rows(trackMarkup(42, false)), [1]);
  assert.deepEqual(rows(broadcastConfirmMarkup()), [2]);
  assert.deepEqual(rows(yandexHealthMarkup()), [1, 1], "обновить / назад — два ряда");
  assert.deepEqual(rows(nowPlayingMarkup("123", "nowymbot")), [2]);
  assert.deepEqual(rows(nowPlayingMarkup("a-uuid", "nowymbot")), [1]);
});

test("клавиатуры: кастом-иконка уходит как icon_custom_emoji_id (декор-ключ yaebal — icon)", async () => {
  await resolveIconSet(
    { api: { getStickerSet: async () => ({ stickers: [{ emoji: "❌", custom_emoji_id: "777" }] }) } } as never,
    "set",
  );
  try {
    const [btn] = cancelAlbumMarkup().build().inline_keyboard.flat();
    assert.equal(btn?.icon_custom_emoji_id, "777");
    assert.equal(btn?.style, "danger");
  } finally {
    await resolveIconSet({ api: { getStickerSet: async () => ({ stickers: [] }) } } as never, "set");
  }
});

// ---------- 429 / uploads ----------

test("429: retry_after из TelegramError.parameters; повтор шлёт аудио и обложку заново (multipart)", async () => {
  const bodies: FormData[] = [];
  let n = 0;
  const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
    n++;
    bodies.push(init?.body as FormData);
    if (n === 1) {
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 0 },
        }),
      );
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 5, audio: { file_id: "AUD" } } }));
  }) as typeof fetch;
  const bot = new Bot("1:test", { fetch: fakeFetch });
  const sender = new ChannelSender(bot, "chan");
  const sent = await sender.sendAudioToChannel(Buffer.from("ID3audio"), {
    filename: "a.mp3",
    title: "T",
    performer: "P",
    duration: 3,
    thumbnail: Buffer.from("jpeg"),
  });
  assert.deepEqual(sent, { fileId: "AUD", messageId: 5 });
  assert.equal(n, 2, "один повтор после 429");
  for (const body of bodies) {
    assert.ok(body instanceof FormData, "multipart");
    assert.match(String(body.get("audio")), /^attach:\/\//);
    assert.match(String(body.get("thumbnail")), /^attach:\/\//);
    const files = [...body.values()].filter((v) => v instanceof Blob) as Blob[];
    assert.equal(files.length, 2, "и аудио, и обложка в теле каждой попытки");
    assert.equal(await files[0]!.text(), "ID3audio");
  }
});

test("TelegramError yaebal: code/description/parameters — форма, на которую опираются floodRetry и isApiError", () => {
  const e = new TelegramError("sendAudio", 429, "Too Many Requests", { retry_after: 3 });
  assert.equal(e.code, 429);
  assert.equal(e.parameters?.retry_after, 3);
  assert.match(e.message, /Too Many Requests/);
});

test("apiRootOf: GramIO-baseURL с /bot → голый origin yaebal; пусто → облако", () => {
  assert.equal(apiRootOf("http://127.0.0.1:8081/bot"), "http://127.0.0.1:8081");
  assert.equal(apiRootOf("http://127.0.0.1:8081/bot/"), "http://127.0.0.1:8081");
  assert.equal(apiRootOf("http://127.0.0.1:8081"), "http://127.0.0.1:8081");
  assert.equal(apiRootOf(""), undefined);
});

// ---------- morda-меню ----------

function menuBot() {
  const storage = new MemoryStorage<DialogState>();
  const container = {
    botUsername: "nowymbot",
    usersDb: { getToken: async () => null },
    knownChatsDb: null,
  } as unknown as Container;
  const bot = buildBot({ token: "1:test", container, dialogStorage: storage, fetch: offlineFetch([]) });
  bot.onError((e) => {
    throw e;
  });
  return { bot, storage, container };
}

const dlgData = (env: ReturnType<typeof createTestEnv>, label: string): string => {
  const msg = env.lastBotMessage({ withReplyMarkup: true });
  const btn = (
    (msg?.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined)
      ?.inline_keyboard ?? []
  )
    .flat()
    .find((b) => b.text.includes(label));
  assert.ok(btn && "callback_data" in btn, `кнопка «${label}»`);
  return String(btn.callback_data);
};

test("меню: /start шлёт меню, «что умею» правит его на месте, клик гасит спиннер", async () => {
  const { bot } = menuBot();
  const env = createTestEnv(bot);
  const user = env.createUser();
  await user.sendCommand("start");
  assert.equal(env.callsTo("sendMessage").length, 1);
  const menu = env.lastBotMessage({ withReplyMarkup: true })!;
  assert.deepEqual(env.lastApiCall("sendMessage")?.params?.link_preview_options, { is_disabled: true });

  await user.click(dlgData(env, MENU_BTN.help), menu);
  const edit = env.lastApiCall("editMessageText");
  assert.ok(edit, "окно сменилось правкой, а не новым сообщением");
  assert.equal(edit.params?.message_id, menu.message_id);
  assert.equal(env.callsTo("sendMessage").length, 1);
  assert.equal(env.callsTo("answerCallbackQuery").length, 1, "спиннер погашен ровно одним ответом");
  env.shutdown();
});

test("меню: повторный /start оставляет старое меню, его кнопка отвечает тостом «устарело»", async () => {
  const { bot } = menuBot();
  const env = createTestEnv(bot);
  const user = env.createUser();
  await user.sendCommand("start");
  const old = env.lastBotMessage({ withReplyMarkup: true })!;
  const oldHelp = dlgData(env, MENU_BTN.help);
  await user.sendCommand("start");
  assert.equal(env.callsTo("deleteMessage").length, 0, "ResetStack GramIO: прежнее меню не удаляется");
  assert.equal(env.callsTo("sendMessage").length, 2);

  env.clearApiCalls();
  await user.click(oldHelp, old);
  const answers = env.callsTo("answerCallbackQuery");
  assert.equal(answers.length, 1);
  assert.equal(answers[0]!.params?.text, STALE_MENU);
  assert.equal(env.callsTo("editMessageText").length, 0);
  env.shutdown();
});

test("меню: состояние истекло (TTL) — кнопка просто гасит спиннер", async () => {
  const { bot, storage } = menuBot();
  const env = createTestEnv(bot);
  const user = env.createUser();
  await user.sendCommand("start");
  const menu = env.lastBotMessage({ withReplyMarkup: true })!;
  const help = dlgData(env, MENU_BTN.help);
  await storage.clear?.();
  for (const k of (await storage.keys?.()) ?? []) await storage.delete(k);
  env.clearApiCalls();
  await user.click(help, menu);
  const answers = env.callsTo("answerCallbackQuery");
  assert.equal(answers.length, 1);
  assert.equal(answers[0]!.params?.text, undefined);
  env.shutdown();
});

test("осиротевшая кнопка (меню GramIO после переезда) — спиннер гасится пустым ответом", async () => {
  const { bot } = menuBot();
  const env = createTestEnv(bot);
  const user = env.createUser();
  await env.dispatch({
    update_id: 9,
    callback_query: { id: "old", from: user.payload, chat_instance: "ci", data: "grd_legacy_payload" },
  });
  const answers = env.callsTo("answerCallbackQuery");
  assert.equal(answers.length, 1);
  assert.equal(answers[0]!.params?.text, undefined);
  env.shutdown();
});

// ---------- webhook ----------

test("webhook: 200 «ok!» уходит до завершения обработки апдейта (ack-first, как GramIO)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const handled: number[] = [];
  const handler = createWebhookHandler(async (u) => {
    await gate;
    handled.push(u.update_id);
  });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const status = await new Promise<{ code: number; body: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/" }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ code: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ update_id: 77 }));
    });
    assert.deepEqual(status, { code: 200, body: "ok!" });
    assert.deepEqual(handled, [], "ответ ушёл, пока апдейт ещё обрабатывается");
    release();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(handled, [77]);
  } finally {
    server.close();
  }
});
