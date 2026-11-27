// трек в лс/чат: подпись и кнопки (♥ / «открыть») по track_layout — как у inline
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Container } from "../src/bot/container.ts";
import { chatAudioExtras, sendTrackToChat } from "../src/bot/handlers/inline/index.ts";
import { chatRichSenders, DEGRADED_NOTE } from "../src/bot/richMessage.ts";
import type { CachedTrack } from "../src/storage/types.ts";
import type { YaTrack } from "../src/yandex/types.ts";

/** текст FormatResult yaebal (`{ text, entities }`, без toString как у GramIO) или строки. */
const textOf = (v: unknown): string =>
  typeof v === "object" && v !== null && "text" in v ? String(v.text) : String(v);

type Call = { method: string; params: Record<string, unknown> };

function mkBot() {
  const calls: Call[] = [];
  const make = (method: string) => async (params: Record<string, unknown>) => {
    calls.push({ method, params });
    return { message_id: 1 };
  };
  const bot = {
    api: {
      sendAudio: make("sendAudio"),
      sendPhoto: make("sendPhoto"),
      deleteMessage: make("deleteMessage"),
      editMessageText: make("editMessageText"),
    },
  };
  return { bot: bot as never, calls };
}

const track: YaTrack = { id: 42, title: "Song", artists: [{ name: "A" }], durationMs: 200000 };
const cachedRow = {
  telegram_file_id: "F",
  is_cached: true,
  codec: "mp3",
  bitrate_kbps: 320,
  artist: "A",
  title: "Song",
} as CachedTrack;

function container(layout: string): Container {
  return {
    botUsername: "nowymbot",
    downloadLimiter: { check: () => [true, 0] as [boolean, number] },
    resolveToken: async () => "tok",
    getUserSettings: async () => ({ track_quality: "best", track_layout: layout, rich_messages: false }),
    getTrackService: async () => ({ getTrackObject: () => track, cacheTrackObject: () => undefined }),
    getYandexService: async () => ({ reportPlayback: async () => undefined }),
    cacheDb: { get: async () => cachedRow },
  } as unknown as Container;
}

function kbJson(markup: unknown): string {
  return JSON.stringify(markup ?? null);
}

async function sendWith(layout: string): Promise<Record<string, unknown>> {
  const { bot, calls } = mkBot();
  await sendTrackToChat({ bot, chatId: 10, userId: 1, container: container(layout), trackId: "42", token: "tok" });
  const sent = calls.find((c) => c.method === "sendAudio");
  assert.ok(sent, JSON.stringify(calls));
  return sent.params;
}

test("лс-трек, layout=button: ♥ + «открыть» кнопками, без подписи", async () => {
  const p = await sendWith("button");
  assert.equal(p.audio, "F");
  assert.equal(p.caption, undefined);
  assert.ok(kbJson(p.reply_markup).includes("like:t:42"));
  assert.ok(kbJson(p.reply_markup).includes("/track/42"));
});

test("лс-трек, layout=text: подпись с качеством и «открыть», без кнопок", async () => {
  const p = await sendWith("text");
  assert.ok(textOf(p.caption).includes("оптимальное 320"), textOf(p.caption));
  assert.ok(textOf(p.caption).includes("открыть"));
  assert.equal(p.reply_markup, undefined);
});

test("лс-трек, layout=both: и подпись, и ♥", async () => {
  const p = await sendWith("both");
  assert.ok(textOf(p.caption).includes("открыть"));
  assert.ok(kbJson(p.reply_markup).includes("like:t:42"));
});

test("лс-трек, layout=none: только файл", async () => {
  const p = await sendWith("none");
  assert.equal(p.caption, undefined);
  assert.equal(p.reply_markup, undefined);
});

test("chatAudioExtras: деградация при layout=button сохраняет отдельную пометку", () => {
  const x = chatAudioExtras({
    trackId: "42",
    fileId: "F",
    codec: "mp3",
    bitrateKbps: 320,
    layout: "button",
    degraded: true,
  });
  assert.equal(x.caption, DEGRADED_NOTE);
  assert.ok(kbJson(x.reply_markup).includes("like:t:42"));
});

test("rich-фолбэк в чат: аудио получает ♥ по track_layout", async () => {
  const { bot, calls } = mkBot();
  const { fallback } = chatRichSenders(bot, 10, {
    trackId: "42",
    trackLayout: "button",
    botUsername: "nowymbot",
    audioExtras: (au) =>
      chatAudioExtras({
        trackId: "42",
        fileId: au.fileId,
        codec: au.codec ?? null,
        bitrateKbps: au.bitrateKbps ?? null,
        layout: "button",
        degraded: au.degraded,
      }),
  });
  await fallback({
    cardFileId: null,
    audio: { fileId: "A", title: "S", performer: "P", durationSec: 1, degraded: false, codec: "mp3", bitrateKbps: 320 },
  });
  const sent = calls.find((c) => c.method === "sendAudio");
  assert.ok(kbJson(sent?.params.reply_markup).includes("like:t:42"));
});
