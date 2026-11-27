/** Smoke-тест запуска yaebal-бота против ФЕЙКОВОГО Bot API (никакого Telegram, никакого
 * боевого токена: второй поллер на боевом токене украл бы апдейты у живого бота).
 *
 * Поднимает локальный http-сервер, имитирующий Bot API (getMe/getUpdates/sendMessage/
 * answerInlineQuery/editMessageText/editMessageMedia/sendAudio/…), и гонит бота ровно так, как main.ts в режиме
 * long-polling: buildBot() + resolveIconSet + registerCommands + deleteWebhook +
 * @yaebal/runner через watchedRunnerBot(PollingWatchdog). Контейнер — без Postgres/Redis:
 * БД-слой заглушен в памяти, кэши и лимитеры настоящие. Через getUpdates уходят:
 *   /start → меню (sendMessage с dlg-кнопками);
 *   inline_query без токена → answerInlineQuery «войти» (is_personal, cache_time ≤ 3);
 *   inline_query с токеном → кэшированное аудио с ♥-клавиатурой;
 *   chosen_inline_result «tm:42» → editMessageMedia по inline_message_id;
 *   callback «что умею» на меню → editMessageText того же сообщения + answerCallbackQuery.
 * Плюс ChannelSender.sendAudioToChannel: первый ответ 429 (retry_after 0) → повтор multipart
 * с аудио и обложкой. Выход 0 — все ожидания сошлись; печатает RSS после загрузки.
 *
 *   node --expose-gc scripts/smoke-fake-api.ts */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Call = { method: string; params: Record<string, unknown>; files: string[] };

const FAKE_TOKEN = "123456:SMOKE-not-a-real-token";
const BOT_USER = { id: 100500, is_bot: true, first_name: "Smoke", username: "smoke_nowym_bot" };
const USER = { id: 555, is_bot: false, first_name: "Аня", username: "anya" };
const STRANGER = { id: 777, is_bot: false, first_name: "Гость" };

// ── фейковый Bot API ────────────────────────────────────────────────────────
const calls: Call[] = [];
const queue: Record<string, unknown>[] = [];
let nextUpdateId = 1;
let nextMessageId = 1000;
let audioAttempts = 0;
const waiters: (() => void)[] = [];

function push(update: Record<string, unknown>): void {
  queue.push({ update_id: nextUpdateId++, ...update });
  for (const w of waiters.splice(0)) w();
}

async function readCall(req: IncomingMessage, method: string): Promise<Call> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const type = String(req.headers["content-type"] ?? "");
  if (type.startsWith("multipart/form-data")) {
    const form = await new Request("http://x/", { method: "POST", headers: { "content-type": type }, body }).formData();
    const params: Record<string, unknown> = {};
    const files: string[] = [];
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") params[k] = v;
      else files.push(`${k}:${v.name}:${v.size}`);
    }
    return { method, params, files };
  }
  return { method, params: body.length ? (JSON.parse(body.toString("utf8")) as Record<string, unknown>) : {}, files: [] };
}

function reply(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
}

const server = createServer((req, res) => {
  void (async () => {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
    if (!m || m[1] !== FAKE_TOKEN) {
      res.writeHead(404).end(JSON.stringify({ ok: false, error_code: 404, description: "Not Found" }));
      return;
    }
    const call = await readCall(req, m[2]!);
    if (call.method !== "getUpdates") calls.push(call);
    const ok = (result: unknown) => reply(res, { ok: true, result });
    switch (call.method) {
      case "getMe":
        return ok(BOT_USER);
      case "getUpdates": {
        const offset = Number(call.params.offset ?? 0);
        while (queue.length && Number(queue[0]!.update_id) < offset) queue.shift();
        if (!queue.length && Number(call.params.timeout ?? 0) > 0) {
          await new Promise<void>((r) => {
            const t = setTimeout(r, 500);
            waiters.push(() => {
              clearTimeout(t);
              r();
            });
          });
        }
        return ok(queue.filter((u) => Number(u.update_id) >= offset));
      }
      case "getStickerSet":
        return ok({ name: "set", title: "set", sticker_type: "custom_emoji", stickers: [] });
      case "sendMessage":
        return ok({
          message_id: nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: call.params.chat_id, type: "private" },
          text: typeof call.params.text === "string" ? call.params.text : "",
        });
      case "sendAudio":
        audioAttempts++;
        if (audioAttempts === 1) {
          return reply(res, {
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 0",
            parameters: { retry_after: 0 },
          });
        }
        return ok({
          message_id: nextMessageId++,
          date: 0,
          chat: { id: -100, type: "channel" },
          audio: { file_id: "UPLOADED_FID", file_unique_id: "u", duration: 3 },
        });
      default:
        return ok(true);
    }
  })().catch((e: unknown) => {
    console.error("fake api:", e);
    if (!res.headersSent) res.writeHead(500).end();
  });
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;

// ── окружение как у test/setup.ts: без боевого .env ─────────────────────────
process.env.NODE_ENV = "test";
process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
process.env.TELEGRAM_CHANNEL_ID = "-100";
process.env.TOKEN_ENCRYPTION_KEY = "smoke-key";
process.env.POSTGRES_USERS_DSN = "postgres://smoke/none";
process.env.POSTGRES_CACHE_DSN = "postgres://smoke/none";
process.env.BOT_API_BASE_URL = `http://127.0.0.1:${port}/bot`;
delete process.env.ADMIN_USER_ID;

const { run } = await import("@yaebal/runner");
const { InlineQueryResult, MemoryStorage } = await import("yaebal");
const { ALLOWED_UPDATES, buildBot, RUNNER_CONCURRENCY } = await import("../src/bot/app.ts");
const { registerCommands } = await import("../src/bot/commandsMenu.ts");
const { resolveIconSet } = await import("../src/bot/iconSet.ts");
const { trackMarkup } = await import("../src/bot/markup.ts");
const { PollingWatchdog, watchedRunnerBot } = await import("../src/bot/pollingWatchdog.ts");
const { ChannelSender } = await import("../src/bot/telegramSender.ts");
const { MENU_BTN } = await import("../src/bot/texts.ts");
const { TTLCache } = await import("../src/infra/memoryCache.ts");
const { UserRateLimiter } = await import("../src/infra/rateLimit.ts");
const { getSettings } = await import("../src/settings.ts");
type Container = import("../src/bot/container.ts").Container;

const s = getSettings();
const settings = {
  track_layout: "button",
  track_send_mode: "audio",
  track_quality: "best",
  card_layout: "button",
  card_progress: "wavy",
  card_aspect: "16:9",
  card_toggles: {},
  rich_messages: false,
};
const cachedTrack = {
  track_id: "42",
  is_cached: true,
  telegram_file_id: "CACHED_FID",
  codec: "mp3",
  bitrate_kbps: 320,
  artist: "Artist",
  title: "Song",
};
const searchService = {
  getTrackObject: () => null,
  cacheTrackObject: () => undefined,
  searchTracksPaged: async () => ({
    results: [InlineQueryResult.cached.audio("42", "CACHED_FID", { reply_markup: trackMarkup(42, true) })],
    nextOffset: "",
  }),
};
const inlineLimiter = new UserRateLimiter(s.RATE_INLINE_MAX_TOKENS, s.RATE_INLINE_RATE_PER_SEC);
const downloadLimiter = new UserRateLimiter(s.RATE_DOWNLOAD_MAX_TOKENS, s.RATE_DOWNLOAD_RATE_PER_SEC);
const caches = {
  trackCache: new TTLCache<unknown[]>(100, 60, 60),
  inlineOwners: new TTLCache<number>(100, 3600, 600),
  inlineEffects: new TTLCache<string>(100, 3600, 600),
};
// Контейнер без Postgres: БД-методы — в памяти; лимитеры и кэши — настоящие.
const container = {
  botUsername: BOT_USER.username,
  npWatcher: null,
  genius: null,
  knownChatsDb: { touch: async () => undefined },
  usersDb: { getToken: async () => null },
  cacheDb: { get: async (id: string) => (id === "42" ? cachedTrack : null) },
  inlineLimiter,
  downloadLimiter,
  ...caches,
  resolveToken: async (uid: number) => (uid === USER.id ? "ya-token" : null),
  getUserSettings: async () => settings,
  getTrackService: async () => searchService,
  getYandexService: async () => ({ getTrackById: async () => null }),
} as unknown as Container;

// ── запуск как в main.ts (long-polling) ─────────────────────────────────────
const bot = buildBot({
  token: s.API_TOKEN,
  apiBaseUrl: s.BOT_API_BASE_URL,
  container,
  dialogStorage: new MemoryStorage(),
});
await resolveIconSet(bot, s.ICON_SET_NAME);
await bot.init();
await registerCommands(bot);
await bot.api.deleteWebhook();
const watchdog = new PollingWatchdog({
  stallMs: 60_000,
  concurrency: RUNNER_CONCURRENCY,
  onFatal: (r) => {
    throw new Error(`watchdog fatal: ${r}`);
  },
});
const runner = run(watchedRunnerBot(bot, watchdog), {
  concurrency: RUNNER_CONCURRENCY,
  sequentializeBy: () => undefined,
  allowedUpdates: ALLOWED_UPDATES,
  onError: (e) => console.error("[runner]", e),
});
watchdog.start();

// ── сценарий ────────────────────────────────────────────────────────────────
const failures: string[] = [];
function check(cond: unknown, what: string): void {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failures.push(what);
}

async function waitFor(pred: (c: Call) => boolean, what: string, ms = 5000): Promise<Call | undefined> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const hit = calls.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  check(false, `${what} (не дождался за ${ms}ms)`);
  return undefined;
}

const pm = { id: USER.id, type: "private", first_name: USER.first_name };
const now = () => Math.floor(Date.now() / 1000);

check(calls.some((c) => c.method === "getMe"), "getMe при init");
check(
  calls.some((c) => c.method === "setMyCommands"),
  "setMyCommands (меню команд)",
);
check(
  calls.some((c) => c.method === "deleteWebhook"),
  "deleteWebhook перед long-polling",
);

// 1) /start
push({
  message: {
    message_id: 1,
    date: now(),
    chat: pm,
    from: USER,
    text: "/start",
    entities: [{ type: "bot_command", offset: 0, length: 6 }],
  },
});
const menu = await waitFor((c) => c.method === "sendMessage" && c.params.chat_id === USER.id, "/start → sendMessage");
const kb = (menu?.params.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined)
  ?.inline_keyboard;
check(kb?.flat().every((b) => !b.callback_data || b.callback_data.startsWith("dlg:")), "меню: кнопки morda (dlg:…)");
const helpBtn = kb?.flat().find((b) => b.text.includes(MENU_BTN.help));
check(helpBtn?.callback_data, "меню: кнопка «что умею»");

// 2) inline без токена
push({ inline_query: { id: "iq-1", from: STRANGER, query: "", offset: "" } });
const iq1 = await waitFor(
  (c) => c.method === "answerInlineQuery" && c.params.inline_query_id === "iq-1",
  "inline без токена → answerInlineQuery",
);
check(iq1?.params.is_personal === true && Number(iq1?.params.cache_time) <= 3, "inline: is_personal + cache_time ≤ 3");
check((iq1?.params.button as { start_parameter?: string } | undefined)?.start_parameter === "login", "inline: кнопка «войти»");

// 3) inline с токеном → результат-аудио
push({ inline_query: { id: "iq-2", from: USER, query: "song", offset: "" } });
const iq2 = await waitFor(
  (c) => c.method === "answerInlineQuery" && c.params.inline_query_id === "iq-2",
  "inline с токеном → answerInlineQuery",
);
const res0 = (iq2?.params.results as Record<string, unknown>[] | undefined)?.[0];
check(res0?.audio_file_id === "CACHED_FID", "inline: cached audio по file_id");
check(
  JSON.stringify(res0?.reply_markup).includes("like:t:42"),
  "inline: InlineKeyboard сериализован в reply_markup (♥)",
);
check(iq2?.params.is_personal === true, "inline: is_personal");

// 4) chosen_inline_result → editMessageMedia по inline_message_id
push({ chosen_inline_result: { result_id: "tm:42", from: USER, query: "song", inline_message_id: "IMSG-42" } });
const media = await waitFor(
  (c) => c.method === "editMessageMedia" && c.params.inline_message_id === "IMSG-42",
  "chosen → editMessageMedia(inline_message_id)",
);
check((media?.params.media as { media?: string } | undefined)?.media === "CACHED_FID", "chosen: аудио из кэша");

// 5) callback по кнопке меню → правка того же сообщения
const menuMsgId = 1000;
push({
  callback_query: {
    id: "cb-1",
    from: USER,
    chat_instance: "ci",
    message: { message_id: menuMsgId, date: now(), chat: pm, from: BOT_USER, text: "menu" },
    data: helpBtn?.callback_data,
  },
});
const edit = await waitFor(
  (c) => c.method === "editMessageText" && c.params.message_id === menuMsgId,
  "callback → editMessageText того же меню",
);
check(edit !== undefined, "меню сменило окно правкой");
await waitFor(
  (c) => c.method === "answerCallbackQuery" && c.params.callback_query_id === "cb-1",
  "callback → answerCallbackQuery",
);

// 6) загрузка аудио в канал: 429 → повтор, multipart с обложкой
const sender = new ChannelSender(bot, "-100");
const sent = await sender.sendAudioToChannel(Buffer.from("ID3-fake-audio"), {
  filename: "track.mp3",
  title: "Song",
  performer: "Artist",
  duration: 3,
  thumbnail: Buffer.from("fake-jpeg"),
});
const audioCalls = calls.filter((c) => c.method === "sendAudio");
check(audioAttempts === 2 && sent.fileId === "UPLOADED_FID", "sendAudio: 429 (retry_after) → повтор → file_id");
check(
  audioCalls.every((c) => c.files.some((f) => f.includes("track.mp3")) && c.files.some((f) => f.includes("cover.jpg"))),
  "sendAudio: каждая попытка — multipart с аудио и обложкой",
);

// ── итог ────────────────────────────────────────────────────────────────────
(globalThis as { gc?: () => void }).gc?.();
const rss = process.memoryUsage().rss;
console.log(`RSS после загрузки и сценария: ${(rss / 1024 / 1024).toFixed(1)} MiB`);
console.log(`вызовов Bot API (кроме getUpdates): ${calls.length}`);

watchdog.stop();
await Promise.race([runner.stop(), new Promise((r) => setTimeout(r, 3000))]);
inlineLimiter.shutdown();
downloadLimiter.shutdown();
await Promise.all(Object.values(caches).map((c) => c.close()));
server.close();
if (failures.length) {
  console.error(`smoke: ${failures.length} провал(ов)`);
  process.exit(1);
}
console.log("smoke: ok");
process.exit(0);
