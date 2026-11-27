/** F1 L3: минт file_id карточки, rich-плейсхолдер инлайна и его разрешение после chosen. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramError } from "yaebal";
import { mintCardFileId } from "../src/bot/cardBuilder.ts";
import type { Container } from "../src/bot/container.ts";
import {
  buildNowPlayingCardResult,
  buildRichNowPlayingResult,
  inlineRichSenders,
  isCardResultId,
  isRichResultId,
  parseRichResultId,
  peekCardPending,
  renderAndSwapCard,
  resolveRichCard,
} from "../src/bot/handlers/inlineCard.ts";
import type { RichAudio } from "../src/bot/richMessage.ts";
import { RICH_RESULT } from "../src/bot/texts.ts";
import type { YaTrack } from "../src/yandex/types.ts";

type Call = { method: string; params: Record<string, unknown> };

function mkBot(opts: { failEditText?: boolean; sendPhotoFails?: unknown[]; photo?: unknown } = {}) {
  const calls: Call[] = [];
  const fails = [...(opts.sendPhotoFails ?? [])];
  const bot = {
    api: {
      sendPhoto: async (params: Record<string, unknown>) => {
        calls.push({ method: "sendPhoto", params });
        const f = fails.shift();
        if (f) throw f;
        return { message_id: 9, photo: opts.photo ?? [{ file_id: "s" }, { file_id: "L" }] };
      },
      deleteMessage: async (params: Record<string, unknown>) => {
        calls.push({ method: "deleteMessage", params });
        return true;
      },
      editMessageText: async (params: Record<string, unknown>) => {
        calls.push({ method: "editMessageText", params });
        if (opts.failEditText)
          throw new TelegramError("editMessageText", 400, "Bad Request: rich_message not supported");
        return true;
      },
      editMessageMedia: async (params: Record<string, unknown>) => {
        calls.push({ method: "editMessageMedia", params });
        return true;
      },
      editMessageReplyMarkup: async (params: Record<string, unknown>) => {
        calls.push({ method: "editMessageReplyMarkup", params });
        return true;
      },
    },
  };
  return { bot: bot as never, calls };
}

function mkTrack(id: number | string = 777): YaTrack {
  return { id, title: "Song", artists: [{ name: "Artist" }] };
}

function mkContainer() {
  const renders: { progressMs: number }[] = [];
  const container = {
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
    cardRenderPool: {
      render: async (a: { progressMs: number }) => {
        renders.push(a);
        return Buffer.from("jpg");
      },
    },
  } as unknown as Container;
  return { container, renders };
}

const audio: RichAudio = { fileId: "FID", title: "Song", performer: "Artist", durationSec: 200, degraded: false };

// --- mintCardFileId (на старом коде: экспорта нет — падает из-за отсутствия экспорта) ---

test("mintCardFileId — берёт самый большой file_id, release удаляет копию в канале ровно один раз", async () => {
  const { bot, calls } = mkBot();
  const card = await mintCardFileId(bot, "chan", Buffer.from("x"), "t");
  assert.equal(card.fileId, "L");
  assert.equal(calls.filter((c) => c.method === "deleteMessage").length, 0);
  card.release();
  card.release();
  await new Promise((r) => setImmediate(r));
  const del = calls.filter((c) => c.method === "deleteMessage");
  assert.equal(del.length, 1);
  assert.deepEqual(del[0]!.params, { chat_id: "chan", message_id: 9 });
});

test("mintCardFileId — пустой photo: бросает и удаляет сообщение в канале", async () => {
  const { bot, calls } = mkBot({ photo: [] });
  await assert.rejects(() => mintCardFileId(bot, "chan", Buffer.from("x"), "t"));
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.filter((c) => c.method === "deleteMessage").length, 1);
});

test("mintCardFileId — 429 с retry_after=0 ретраится (floodRetry сохранён)", async () => {
  const { bot, calls } = mkBot({
    sendPhotoFails: [new TelegramError("sendPhoto", 429, "Too Many Requests", { retry_after: 0 })],
  });
  const card = await mintCardFileId(bot, "chan", Buffer.from("x"), "t");
  assert.equal(card.fileId, "L");
  assert.equal(calls.filter((c) => c.method === "sendPhoto").length, 2);
});

test("mintCardFileId — release не бросает, даже если deleteMessage падает", async () => {
  const { bot } = mkBot();
  (bot as { api: { deleteMessage: unknown } }).api.deleteMessage = async () => {
    throw new Error("gone");
  };
  const card = await mintCardFileId(bot, "chan", Buffer.from("x"), "t");
  assert.doesNotThrow(() => card.release());
  await new Promise((r) => setImmediate(r));
});

// --- placeholder id ---

test("npr: id — round-trip, user-изоляция, isCardResultId не затронут", () => {
  const { container } = mkContainer();
  const r1 = buildRichNowPlayingResult(container, mkTrack(777), { progress_ms: 5000 }, { id: 1 }) as { id: string };
  const r2 = buildRichNowPlayingResult(container, mkTrack(777), { progress_ms: 5000 }, { id: 2 }) as { id: string };
  assert.match(r1.id, /^npr:1:777:5$/);
  assert.notEqual(r1.id, r2.id);
  assert.deepEqual(parseRichResultId(r1.id), { userId: 1, trackId: "777", sec: 5 });
  assert.equal(isRichResultId(r1.id), true);
  assert.equal(isCardResultId(r1.id), false);
  assert.equal(peekCardPending(r1.id)?.progressMs, 5000);
});

test("npr: id — id трека с двоеточием (album track) парсится", () => {
  assert.deepEqual(parseRichResultId("npr:5:123:456:7"), { userId: 5, trackId: "123:456", sec: 7 });
});

test("parseRichResultId — мусор отвергается", () => {
  for (const bad of ["", "npc:1:2:3", "npr:", "npr:x:2:3", "npr:1:2:y", "npr:1::3", "npr:1:2", "tm:1", "npr:1:2:-3"]) {
    assert.equal(parseRichResultId(bad), null, bad);
  }
  assert.equal(isRichResultId("tm:1"), false);
});

test("buildRichNowPlayingResult — плейсхолдер-текст и reply_markup (нужен для inline_message_id)", () => {
  const { container } = mkContainer();
  const r = buildRichNowPlayingResult(container, mkTrack(777), { progress_ms: 5000 }, { id: 1 }) as unknown as {
    input_message_content: { message_text: string };
    reply_markup?: unknown;
  };
  assert.equal(r.input_message_content.message_text, RICH_RESULT.placeholder);
  assert.ok(r.reply_markup);
});

// --- inlineRichSenders ---

test("inlineRichSenders — sendRich: editMessageText с inline_message_id и rich_message без text", async () => {
  const { bot, calls } = mkBot();
  const s = inlineRichSenders(bot, "IM", {
    trackId: "777",
    trackLayout: "button",
    cardLayout: "button",
    botUsername: "b",
  });
  await s.sendRich({ blocks: [] });
  assert.equal(calls[0]!.method, "editMessageText");
  assert.equal(calls[0]!.params.inline_message_id, "IM");
  assert.ok(calls[0]!.params.rich_message);
  assert.equal("text" in calls[0]!.params, false);
});

test("inlineRichSenders — fallback: карточка → photo; только трек → audio; ничего → ничего", async () => {
  const { bot, calls } = mkBot();
  const s = inlineRichSenders(bot, "IM", {
    trackId: "777",
    trackLayout: "button",
    cardLayout: "button",
    botUsername: "b",
  });
  await s.fallback({ cardFileId: "CARD", audio });
  await s.fallback({ cardFileId: null, audio: { ...audio, degraded: true } });
  assert.equal(calls.length, 2);
  assert.equal((calls[0]!.params.media as { type: string; media: string }).type, "photo");
  assert.equal((calls[0]!.params.media as { media: string }).media, "CARD");
  assert.equal((calls[1]!.params.media as { type: string; media: string }).type, "audio");
  assert.equal((calls[1]!.params.media as { media: string }).media, "FID");
  assert.ok((calls[1]!.params.media as { caption?: string }).caption);
});

// --- resolveRichCard ---

test("resolveRichCard — успех: editMessageText с photo+audio блоками и reply_markup, затем delete канала", async () => {
  const { container, renders } = mkContainer();
  const { bot, calls } = mkBot();
  const r = buildRichNowPlayingResult(container, mkTrack(777), { progress_ms: 5000 }, { id: 1 }) as { id: string };
  const res = await resolveRichCard(bot, container, r.id, "IM", async () => audio);
  await new Promise((r) => setImmediate(r));
  assert.equal(res, "rich");
  assert.equal(renders[0]!.progressMs, 5000);
  const edit = calls.find((c) => c.method === "editMessageText")!;
  const blocks = (edit.params.rich_message as { blocks: { type: string }[] }).blocks;
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["photo", "audio"],
  );
  assert.ok(edit.params.reply_markup);
  assert.equal(edit.params.inline_message_id, "IM");
  assert.equal(
    calls.some((c) => c.method === "editMessageMedia"),
    false,
  );
  const idxEdit = calls.indexOf(edit);
  const idxDel = calls.findIndex((c) => c.method === "deleteMessage");
  assert.ok(idxDel > idxEdit, "канал чистим после использования file_id");
});

test("resolveRichCard — сбой sendRich: фолбэк photo с теми же file_id, второго рендера нет", async () => {
  const { container, renders } = mkContainer();
  const { bot, calls } = mkBot({ failEditText: true });
  const r = buildRichNowPlayingResult(container, mkTrack(777), { progress_ms: 5000 }, { id: 1 }) as { id: string };
  const res = await resolveRichCard(bot, container, r.id, "IM", async () => audio);
  assert.equal(res, "fallback");
  assert.equal(renders.length, 1);
  assert.equal(calls.filter((c) => c.method === "sendPhoto").length, 1);
  const media = calls.find((c) => c.method === "editMessageMedia")!;
  assert.equal((media.params.media as { type: string; media: string }).type, "photo");
  assert.equal((media.params.media as { media: string }).media, "L");
});

test("resolveRichCard — нет стэша (вытеснен): retry-разметка, без рендера", async () => {
  const { container, renders } = mkContainer();
  const { bot, calls } = mkBot();
  const res = await resolveRichCard(bot, container, "npr:1:777:9", "IM", async () => audio);
  assert.equal(res, "expired");
  assert.equal(renders.length, 0);
  const kb = calls.find((c) => c.method === "editMessageReplyMarkup")!;
  assert.equal(kb.params.inline_message_id, "IM");
  assert.ok(JSON.stringify(kb.params.reply_markup).includes("load:777"));
});

test("resolveRichCard — ни карточки, ни трека: retry-разметка", async () => {
  const { container } = mkContainer();
  (container as unknown as { cardRenderPool: { render: () => Promise<Buffer> } }).cardRenderPool.render = async () => {
    throw new Error("pool down");
  };
  const { bot, calls } = mkBot();
  const r = buildRichNowPlayingResult(container, mkTrack(777), { progress_ms: 0 }, { id: 1 }) as { id: string };
  const res = await resolveRichCard(bot, container, r.id, "IM", async () => null);
  assert.equal(res, "none");
  const kb = calls.find((c) => c.method === "editMessageReplyMarkup")!;
  assert.ok(JSON.stringify(kb.params.reply_markup).includes("load:777"));
});

// --- регресс-гард: старый npc: путь (проходит и на старом коде) ---

test("[regression guard] renderAndSwapCard — render → mint → editMessageMedia → delete канала", async () => {
  const { container, renders } = mkContainer();
  const { bot, calls } = mkBot();
  const r = buildNowPlayingCardResult(container, mkTrack(778), { progress_ms: 3000 }, { id: 1 }) as { id: string };
  await renderAndSwapCard(bot, container, r.id, "IM");
  await new Promise((r) => setImmediate(r));
  assert.equal(renders.length, 1);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["sendPhoto", "editMessageMedia", "deleteMessage"],
  );
  assert.equal((calls[1]!.params.media as { media: string }).media, "L");
});
