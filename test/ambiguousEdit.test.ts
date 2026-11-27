/** review-2 #2: editMessageMedia упал без ответа API (сеть/таймаут) — исход неизвестен:
 * повторяем ту же правку один раз, а не ставим «загрузить снова» под уже доставленное медиа. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramError } from "gramio";
import type { Container } from "../src/bot/container.ts";
import { onChosenResult, registerInline } from "../src/bot/handlers/inline/index.ts";
import { buildNowPlayingCardResult, renderAndSwapCard } from "../src/bot/handlers/inlineCard.ts";
import { isApiError } from "../src/bot/richMessage.ts";
import type { CachedTrack } from "../src/storage/types.ts";
import type { YaTrack } from "../src/yandex/types.ts";

type Call = { method: string; params: Record<string, unknown> };

const apiErr = () =>
  new TelegramError(
    { ok: false, error_code: 400, description: "Bad Request: wrong file" } as never,
    "editMessageMedia" as never,
    {} as never,
  );
const netErr = () => new TypeError("fetch failed");

/** editFails — что бросают первые вызовы editMessageMedia по очереди (дальше успех). */
function mkBot(editFails: unknown[]) {
  const calls: Call[] = [];
  const fails = [...editFails];
  const rec =
    (method: string, ret: unknown = true) =>
    async (params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "editMessageMedia") {
        const f = fails.shift();
        if (f) throw f;
      }
      return ret;
    };
  const bot = {
    api: {
      editMessageMedia: rec("editMessageMedia"),
      editMessageReplyMarkup: rec("editMessageReplyMarkup"),
      sendPhoto: rec("sendPhoto", { message_id: 9, photo: [{ file_id: "CARD" }] }),
      deleteMessage: rec("deleteMessage"),
    },
  };
  return { bot: bot as never, calls };
}

const track = (id = 42): YaTrack => ({ id, title: "Song", artists: [{ name: "A" }], durationMs: 200000 });

const cachedRow = {
  telegram_file_id: "F",
  is_cached: true,
  codec: "mp3",
  bitrate_kbps: 320,
  artist: "A",
  title: "S",
} as CachedTrack;

function trackContainer() {
  const t = track(42);
  return {
    botUsername: "nowymbot",
    inlineOwners: new Map<string, number>([["IM", 1]]),
    inlineEffects: new Map<string, string>(),
    downloadLimiter: { check: () => [true, 0] as [boolean, number] },
    resolveToken: async () => "tok",
    getUserSettings: async () => ({ track_quality: "best", track_layout: "button" }),
    getTrackService: async () => ({ getTrackObject: () => t, cacheTrackObject: () => undefined }),
    getYandexService: async () => ({}),
    cacheDb: { get: async () => cachedRow },
  } as unknown as Container;
}

const count = (calls: Call[], m: string) => calls.filter((c) => c.method === m).length;
const hasRetry = (calls: Call[]) =>
  calls.some((c) => c.method === "editMessageReplyMarkup" && JSON.stringify(c.params).includes("загрузить снова"));

test("isApiError: TelegramError — да, сетевой сбой — нет", () => {
  assert.equal(isApiError(apiErr()), true);
  assert.equal(isApiError(netErr()), false);
});

const chosen = (bot: never) =>
  onChosenResult({ from: { id: 1 }, resultId: "tm:42", inlineMessageId: "IM", query: "song" }, trackContainer(), bot);

test("chosen: сетевой сбой финального edit → тот же edit повторён, без «загрузить снова»", async () => {
  const { bot, calls } = mkBot([netErr()]);
  await chosen(bot);
  const edits = calls.filter((c) => c.method === "editMessageMedia");
  assert.equal(edits.length, 2);
  assert.deepEqual(edits[1]!.params, edits[0]!.params);
  assert.equal(hasRetry(calls), false);
});

test("chosen: повтор после сетевого сбоя тоже упал → «загрузить снова»", async () => {
  const { bot, calls } = mkBot([netErr(), netErr()]);
  await chosen(bot);
  assert.equal(count(calls, "editMessageMedia"), 2);
  assert.equal(hasRetry(calls), true);
});

test("chosen: ответ API на edit → без повтора, «загрузить снова» как раньше", async () => {
  const { bot, calls } = mkBot([apiErr()]);
  await chosen(bot);
  assert.equal(count(calls, "editMessageMedia"), 1);
  assert.equal(hasRetry(calls), true);
});

function loadTap(bot: { api: unknown }) {
  let fn!: (ctx: unknown) => Promise<void>;
  const reg = {
    inlineQuery: () => undefined,
    chosenInlineResult: () => undefined,
    callbackQuery: (re: RegExp, h: (ctx: unknown) => Promise<void>) => {
      if (re.test("load:1")) fn = h;
    },
    api: bot.api,
  };
  registerInline(reg as never, trackContainer());
  return fn({ data: "load:42", inlineMessageId: "IM", from: { id: 1 }, answer: async () => true });
}

test("load: сетевой сбой edit → повтор того же edit, без «загрузить снова»", async () => {
  const { bot, calls } = mkBot([netErr()]);
  await loadTap(bot as never);
  assert.equal(count(calls, "editMessageMedia"), 2);
  assert.equal(hasRetry(calls), false);
});

test("load: ответ API на edit → без повтора, «загрузить снова»", async () => {
  const { bot, calls } = mkBot([apiErr()]);
  await loadTap(bot as never);
  assert.equal(count(calls, "editMessageMedia"), 1);
  assert.equal(hasRetry(calls), true);
});

function cardContainer() {
  return {
    botUsername: "nowymbot",
    channelId: "chan",
    getUserSettings: async () => ({
      track_layout: "button",
      card_toggles: { avatar: false },
      card_progress: "bar",
      card_style: "dark",
      card_aspect: "square",
    }),
    resolveToken: async () => null,
    cardRenderPool: { render: async () => Buffer.from("jpg") },
  } as unknown as Container;
}

test("карточка: сетевой сбой правки → повтор той же правки, без retry-разметки", async () => {
  const container = cardContainer();
  const r = buildNowPlayingCardResult(container, track(901), { progress_ms: 0 }, { id: 1 }) as { id: string };
  const { bot, calls } = mkBot([netErr()]);
  await renderAndSwapCard(bot, container, r.id, "IM", 1);
  const edits = calls.filter((c) => c.method === "editMessageMedia");
  assert.equal(edits.length, 2);
  assert.equal((edits[1]!.params.media as { media: string }).media, "CARD");
  assert.equal(count(calls, "editMessageReplyMarkup"), 0);
});

test("карточка: ответ API на правку → без повтора, retry-разметка", async () => {
  const container = cardContainer();
  const r = buildNowPlayingCardResult(container, track(902), { progress_ms: 0 }, { id: 1 }) as { id: string };
  const { bot, calls } = mkBot([apiErr()]);
  await renderAndSwapCard(bot, container, r.id, "IM", 1);
  assert.equal(count(calls, "editMessageMedia"), 1);
  assert.equal(count(calls, "editMessageReplyMarkup"), 1);
});
