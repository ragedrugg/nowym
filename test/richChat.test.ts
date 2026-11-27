/** F1 L6: «карточка+трек» одним rich-сообщением в /np, кнопках меню и deep link track_<id>. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramError } from "gramio";
import type { Container } from "../src/bot/container.ts";
import { deepLinkCardPosition, renderNowPlaying, sendCurrentTrack } from "../src/bot/handlers/common.ts";
import { sendTrackToChat } from "../src/bot/handlers/inline/index.ts";
import type { YaTrack } from "../src/yandex/types.ts";

type Call = { method: string; params: Record<string, unknown> };

const track = (id = 777, durationMs = 200000): YaTrack => ({
  id,
  title: "Song",
  artists: [{ name: "Artist" }],
  durationMs,
});

function mkBot(opts: { failRich?: boolean } = {}) {
  const calls: Call[] = [];
  const rec =
    (method: string, ret: unknown = true) =>
    async (params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "sendRichMessage" && opts.failRich)
        throw new TelegramError(
          { ok: false, error_code: 400, description: "Bad Request: rich" } as never,
          "sendRichMessage" as never,
          {} as never,
        );
      if (method === "sendPhoto" && params.chat_id === "chan") return { message_id: 9, photo: [{ file_id: "CARD" }] };
      return ret;
    };
  const bot = {
    api: {
      sendPhoto: rec("sendPhoto", { message_id: 1, photo: [{ file_id: "X" }] }),
      sendAudio: rec("sendAudio"),
      sendRichMessage: rec("sendRichMessage"),
      deleteMessage: rec("deleteMessage"),
      editMessageText: rec("editMessageText"),
      sendMessage: rec("sendMessage"),
    },
  };
  return { bot: bot as never, calls };
}

type Snap = { track: YaTrack; progress_ms: number; duration_ms: number; paused: boolean };

function mkContainer(
  o: {
    rich?: boolean;
    allowed?: boolean;
    cached?: boolean;
    snap?: Snap | null;
    owner?: number;
    obj?: YaTrack | null;
  } = {},
) {
  const renders: { progressMs: number; durationMs: number; hideProgress?: boolean }[] = [];
  const yaCalls: string[] = [];
  const yaTrack = o.obj === undefined ? track() : o.obj;
  const container = {
    botUsername: "nowymbot",
    channelId: "chan",
    downloadLimiter: { check: () => (o.allowed === false ? [false, 7.2] : [true, 0]) },
    resolveToken: async () => "tok",
    getUserSettings: async () => ({
      rich_messages: o.rich ?? true,
      track_layout: "button",
      track_quality: "best",
      card_toggles: { avatar: false },
      card_progress: "bar",
      card_style: "dark",
      card_aspect: "square",
    }),
    getTrackService: async () => ({ getTrackObject: () => yaTrack, cacheTrackObject() {} }),
    getYandexService: async () => {
      yaCalls.push("yandex");
      return { reportPlayback: async () => {}, getCurrentTrack: async () => null, getTrackById: async () => yaTrack };
    },
    cacheDb: {
      get: async () =>
        o.cached === false
          ? null
          : { telegram_file_id: "FID", is_cached: true, codec: "mp3", bitrate_kbps: 320, duration: 200 },
    },
    cardRenderPool: {
      render: async (a: { progressMs: number; durationMs: number; hideProgress?: boolean }) => {
        renders.push(a);
        return Buffer.from("jpg");
      },
    },
    npWatcher:
      o.snap === undefined && o.owner === undefined
        ? null
        : { ownerId: o.owner ?? 1, getCurrentSnapshot: () => o.snap ?? null },
  } as unknown as Container;
  return { container, renders, yaCalls };
}

const user = { id: 1, username: "u" };
const card = { progressMs: 42000, durationMs: 200000, paused: false };
const methods = (calls: Call[]) => calls.map((c) => c.method);
const blocks = (c: Call) =>
  (c.params.rich_message as { blocks: { type: string; photo?: { media: string }; audio?: { media: string } }[] })
    .blocks;
const snap: Snap = { track: track(), progress_ms: 42000, duration_ms: 200000, paused: false };

test("sendTrackToChat: rich ON + card: один sendRichMessage [CARD, FID], без sendAudio, статус и копия канала удалены", async () => {
  const { container, renders } = mkContainer();
  const { bot, calls } = mkBot();
  await sendTrackToChat({ bot, chatId: 10, userId: 1, user, container, trackId: "777", statusMsgId: 5, card });
  assert.equal(renders.length, 1);
  assert.equal(renders[0]!.progressMs, 42000);
  const rich = calls.filter((c) => c.method === "sendRichMessage");
  assert.equal(rich.length, 1);
  assert.equal(rich[0]!.params.chat_id, 10);
  assert.equal(blocks(rich[0]!)[0]!.photo!.media, "CARD");
  assert.equal(blocks(rich[0]!)[1]!.audio!.media, "FID");
  assert.equal(methods(calls).includes("sendAudio"), false);
  const dels = calls.filter((c) => c.method === "deleteMessage").map((c) => c.params);
  assert.ok(
    dels.some((p) => p.chat_id === 10 && p.message_id === 5),
    "статус удалён",
  );
  await new Promise((r) => setImmediate(r));
  assert.ok(
    calls.some((c) => c.method === "deleteMessage" && c.params.chat_id === "chan" && c.params.message_id === 9),
    "копия в канале удалена",
  );
});

test("sendTrackToChat: rich упал: фолбэк sendPhoto(CARD) + sendAudio(FID) из тех же file_id, один рендер, без ошибки", async () => {
  const { container, renders } = mkContainer();
  const { bot, calls } = mkBot({ failRich: true });
  await sendTrackToChat({ bot, chatId: 10, userId: 1, user, container, trackId: "777", statusMsgId: 5, card });
  assert.equal(renders.length, 1);
  const sent = calls
    .filter((c) => c.params.chat_id === 10 && ["sendPhoto", "sendAudio"].includes(c.method))
    .map((c) => [c.method, c.params.photo ?? c.params.audio]);
  assert.deepEqual(sent, [
    ["sendPhoto", "CARD"],
    ["sendAudio", "FID"],
  ]);
  assert.equal(methods(calls).includes("sendMessage"), false);
  assert.equal(methods(calls).includes("editMessageText"), false, "пользователю об ошибке не пишем");
});

test("sendTrackToChat: лимитер отказал: без рендера и без отправки", async () => {
  const { container, renders } = mkContainer({ allowed: false });
  const { bot, calls } = mkBot();
  await sendTrackToChat({ bot, chatId: 10, userId: 1, user, container, trackId: "777", statusMsgId: 5, card });
  assert.equal(renders.length, 0);
  assert.equal(methods(calls).includes("sendRichMessage"), false);
});

test("sendTrackToChat: rich ON, кэша нет, трек слишком длинный: карточка фолбэком, статус с ошибкой, без rich", async () => {
  const { container } = mkContainer({ cached: false, obj: track(777, 5 * 3600 * 1000) });
  const { bot, calls } = mkBot();
  await sendTrackToChat({ bot, chatId: 10, userId: 1, user, container, trackId: "777", statusMsgId: 5, card });
  assert.equal(methods(calls).includes("sendRichMessage"), false);
  assert.ok(calls.some((c) => c.method === "sendPhoto" && c.params.photo === "CARD"));
  assert.equal(methods(calls).includes("sendAudio"), false);
  assert.ok(
    calls.some((c) => c.method === "editMessageText"),
    "статус отредактирован текстом ошибки",
  );
});

test("[regression guard] sendTrackToChat: rich OFF + card: только sendAudio, рендера нет", async () => {
  const { container, renders } = mkContainer({ rich: false });
  const { bot, calls } = mkBot();
  await sendTrackToChat({ bot, chatId: 10, userId: 1, user, container, trackId: "777", statusMsgId: 5, card });
  assert.equal(renders.length, 0);
  assert.deepEqual(
    methods(calls).filter((m) => m !== "deleteMessage"),
    ["sendAudio"],
  );
  // track_layout=button: chat_id + audio + ♥/«открыть», без caption/rich_message
  const p = calls.find((c) => c.method === "sendAudio")!.params;
  assert.deepEqual(Object.keys(p).sort(), ["audio", "chat_id", "reply_markup"]);
  assert.equal(p.audio, "FID");
  assert.ok(JSON.stringify(p.reply_markup).includes("like:t:777"));
  assert.deepEqual(
    calls.filter((c) => c.method === "deleteMessage").map((c) => c.params),
    [{ chat_id: 10, message_id: 5 }],
  );
});

test("[regression guard] sendTrackToChat: rich ON, но без card: только sendAudio", async () => {
  const { container, renders } = mkContainer();
  const { bot, calls } = mkBot();
  await sendTrackToChat({ bot, chatId: 10, userId: 1, container, trackId: "777", statusMsgId: 5 });
  assert.equal(renders.length, 0);
  assert.equal(methods(calls).includes("sendRichMessage"), false);
  assert.ok(methods(calls).includes("sendAudio"));
});

test("sendTrackToChat: deep link не играющего трека (card 0:00): карточка с progressMs 0, длительность из трека", async () => {
  const { container, renders } = mkContainer();
  const { bot, calls } = mkBot();
  const pos = deepLinkCardPosition(container, 1, "777");
  await sendTrackToChat({ bot, chatId: 10, userId: 1, user, container, trackId: "777", statusMsgId: 5, card: pos });
  assert.equal(renders[0]!.progressMs, 0);
  assert.equal(renders[0]!.durationMs, 200000);
  assert.equal(renders[0]!.hideProgress, true, "по ссылке без воспроизведения линии прогресса нет");
  assert.equal(calls.filter((c) => c.method === "sendRichMessage").length, 1);
});

// --- renderNowPlaying / sendCurrentTrack ---

test("renderNowPlaying: rich ON: позиция из снапшота, один sendRichMessage, без sendPhoto-буфера в чат", async () => {
  const { container, renders } = mkContainer({ snap, owner: 1 });
  const { bot, calls } = mkBot();
  await renderNowPlaying(bot, 10, user, container, 5);
  assert.equal(renders[0]!.progressMs, 42000);
  assert.equal(calls.filter((c) => c.method === "sendRichMessage").length, 1);
  assert.equal(
    calls.some((c) => c.method === "sendPhoto" && c.params.chat_id === 10),
    false,
  );
});

test("sendCurrentTrack (кнопка меню): rich ON: один sendRichMessage с позицией снапшота", async () => {
  const { container, renders } = mkContainer({ snap, owner: 1 });
  const { bot, calls } = mkBot();
  await sendCurrentTrack(bot, 10, user, container, 5);
  assert.equal(renders[0]!.progressMs, 42000);
  assert.equal(calls.filter((c) => c.method === "sendRichMessage").length, 1);
  assert.equal(methods(calls).includes("sendAudio"), false);
});

test("renderNowPlaying: лимитер отказал: без рендера", async () => {
  const { container, renders } = mkContainer({ snap, owner: 1, allowed: false });
  const { bot, calls } = mkBot();
  await renderNowPlaying(bot, 10, user, container, 5);
  assert.equal(renders.length, 0);
  assert.equal(methods(calls).includes("sendRichMessage"), false);
});

test("[regression guard] renderNowPlaying: rich OFF: sendPhoto буфером, без sendRichMessage", async () => {
  const { container, renders } = mkContainer({ snap, owner: 1, rich: false });
  const { bot, calls } = mkBot();
  await renderNowPlaying(bot, 10, user, container, 5);
  assert.equal(methods(calls).includes("sendRichMessage"), false);
  const photos = calls.filter((c) => c.method === "sendPhoto" && c.params.chat_id === 10);
  assert.equal(photos.length, 1);
  assert.deepEqual(Object.keys(photos[0]!.params).sort(), ["chat_id", "photo", "reply_markup"]);
  assert.ok(JSON.stringify(photos[0]!.params.reply_markup).includes("start=track_777"));
  assert.equal(methods(calls).includes("sendAudio"), false);
  assert.equal(renders.length, 1, "старый путь рендерит карточку один раз");
});

test("[regression guard] sendCurrentTrack: rich OFF: только sendAudio", async () => {
  const { container, renders } = mkContainer({ snap, owner: 1, rich: false });
  const { bot, calls } = mkBot();
  await sendCurrentTrack(bot, 10, user, container, 5);
  assert.equal(renders.length, 0);
  const sent = calls.filter((c) => c.method === "sendAudio").map((c) => c.params);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.audio, "FID");
  assert.ok(JSON.stringify(sent[0]!.reply_markup).includes("like:t:777"));
  assert.equal(methods(calls).includes("sendRichMessage"), false);
});

test("sendTrackToChat: карточка с позицией воспроизведения (/np): линия прогресса остаётся", async () => {
  const { container, renders } = mkContainer();
  const { bot } = mkBot();
  await sendTrackToChat({
    bot,
    chatId: 10,
    userId: 1,
    user,
    container,
    trackId: "777",
    statusMsgId: 5,
    card: { progressMs: 42000, durationMs: 200000, paused: false },
  });
  assert.equal(renders[0]!.hideProgress, false);
});

// --- deepLinkCardPosition ---

test("deepLinkCardPosition: владелец + тот же трек: позиция снапшота", () => {
  const { container } = mkContainer({ snap, owner: 1 });
  assert.deepEqual(deepLinkCardPosition(container, 1, "777"), { progressMs: 42000, durationMs: 200000, paused: false });
});

test("deepLinkCardPosition: другой трек или не владелец: нули, без обращения к Yandex", () => {
  const { container, yaCalls } = mkContainer({ snap, owner: 1 });
  const zero = { progressMs: 0, durationMs: 0, paused: false };
  assert.deepEqual(deepLinkCardPosition(container, 1, "999"), zero);
  assert.deepEqual(deepLinkCardPosition(container, 2, "777"), zero);
  assert.equal(yaCalls.length, 0);
});
