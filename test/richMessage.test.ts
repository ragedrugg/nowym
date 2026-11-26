/** richMessage — адаптер Telegram Rich Messages (карточка + трек одним сообщением). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { type Bot, TelegramError } from "gramio";
import {
  buildRichCardTrack,
  chatRichSenders,
  DEGRADED_NOTE,
  deliverCardAndTrack,
  type MintedCard,
  makeRichSend,
  type RichAudio,
  richTrackMarkup,
} from "../src/bot/richMessage.ts";

type Call = { method: string; params: Record<string, unknown> };

const audio = (over: Partial<RichAudio> = {}): RichAudio => ({
  fileId: "AUD",
  title: "Song",
  performer: "Artist",
  durationSec: 213,
  degraded: false,
  ...over,
});

function stubBot(throwers: Record<string, Error> = {}): { bot: Bot; calls: Call[] } {
  const calls: Call[] = [];
  const make = (method: string) => async (params: Record<string, unknown>) => {
    calls.push({ method, params });
    const err = throwers[method];
    if (err) throw err;
    return {};
  };
  const bot = {
    api: {
      sendRichMessage: make("sendRichMessage"),
      editMessageText: make("editMessageText"),
      sendPhoto: make("sendPhoto"),
      sendAudio: make("sendAudio"),
    },
  } as unknown as Bot;
  return { bot, calls };
}

/** перехват строк логгера (warning уходит в stdout). */
function captureLog(t: { mock: { method: (o: object, m: "write", f: never) => unknown } }): string[] {
  const lines: string[] = [];
  t.mock.method(process.stdout, "write", ((s: string | Uint8Array) => {
    lines.push(String(s));
    return true;
  }) as never);
  return lines;
}

type Blk = { type: string; photo: { media: unknown }; audio: Record<string, unknown>; caption?: unknown };
/** блоки rich-сообщения в свободной форме для проверок полей. */
const blocksOf = (r: { blocks?: unknown }): [Blk, Blk] => r.blocks as [Blk, Blk];
const at = (calls: Call[], i: number): Call => calls[i] as Call;
const rich = () => buildRichCardTrack("CARD", audio());

test("buildRichCardTrack: точная проверенная форма (photo, затем audio)", () => {
  assert.deepEqual(buildRichCardTrack("CARD", audio()), {
    blocks: [
      { type: "photo", photo: { type: "photo", media: "CARD" } },
      {
        type: "audio",
        audio: { type: "audio", media: "AUD", title: "Song", performer: "Artist", duration: 213 },
      },
    ],
  });
});

test("buildRichCardTrack: порядок блоков и имена полей (photo первым, media/title/performer/duration)", () => {
  const blocks = blocksOf(buildRichCardTrack("CARD", audio()));
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["photo", "audio"],
  );
  assert.equal(blocks[0].photo.media, "CARD");
  assert.equal(blocks[1].audio.media, "AUD");
  assert.deepEqual(Object.keys(blocks[1].audio).sort(), ["duration", "media", "performer", "title", "type"]);
  assert.equal("caption" in blocks[0], false);
});

test("buildRichCardTrack: пустой исполнитель и неизвестная длительность опускаются", () => {
  const a = blocksOf(buildRichCardTrack("C", audio({ performer: "  ", durationSec: null })))[1].audio;
  assert.equal("performer" in a, false);
  assert.equal("duration" in a, false);
  const b = blocksOf(buildRichCardTrack("C", audio({ durationSec: 0 })))[1].audio;
  assert.equal("duration" in b, false);
});

test("buildRichCardTrack: длительность округляется до целого, строки обрезаются", () => {
  const a = blocksOf(buildRichCardTrack("C", audio({ durationSec: 213.6 })))[1].audio;
  assert.equal(a.duration, 214);
  const long = "x".repeat(1000);
  const b = blocksOf(buildRichCardTrack("C", audio({ title: long, performer: long })))[1].audio;
  assert.ok(String(b.title).length <= 256 && String(b.performer).length <= 256);
});

test("buildRichCardTrack: degraded добавляет подпись только к audio-блоку; media всегда строка", () => {
  const blocks = blocksOf(buildRichCardTrack("C", audio({ degraded: true })));
  assert.equal("caption" in blocks[0], false);
  assert.deepEqual(blocks[1].caption, { text: DEGRADED_NOTE });
  assert.equal(typeof blocks[0].photo.media, "string");
  assert.equal(typeof blocks[1].audio.media, "string");
});

test("richTrackMarkup: none => undefined; иначе есть like:t:<id>", () => {
  assert.equal(richTrackMarkup("77", "none"), undefined);
  for (const layout of ["button", "both", "text"]) {
    assert.ok(JSON.stringify(richTrackMarkup("77", layout)).includes("like:t:77"));
  }
});

test("makeRichSend: чат => sendRichMessage(chat_id, rich_message, reply_markup)", async () => {
  const { bot, calls } = stubBot();
  await makeRichSend(bot, { kind: "chat", chatId: 10 }, "MK" as never)(rich());
  assert.equal(calls.length, 1);
  assert.equal(at(calls, 0).method, "sendRichMessage");
  assert.equal(at(calls, 0).params.chat_id, 10);
  assert.deepEqual(at(calls, 0).params.rich_message, rich());
  assert.equal(at(calls, 0).params.reply_markup, "MK");
});

test("makeRichSend: inline => editMessageText(inline_message_id, rich_message) без text", async () => {
  const { bot, calls } = stubBot();
  await makeRichSend(bot, { kind: "inline", inlineMessageId: "IM" })(rich());
  assert.equal(at(calls, 0).method, "editMessageText");
  assert.equal(at(calls, 0).params.inline_message_id, "IM");
  assert.equal("text" in at(calls, 0).params, false);
  assert.equal("chat_id" in at(calls, 0).params, false);
  assert.equal(blocksOf(at(calls, 0).params.rich_message as { blocks?: unknown }).length, 2);
});

test("makeRichSend: правка сообщения чата => editMessageText(chat_id, message_id, rich_message)", async () => {
  const { bot, calls } = stubBot();
  await makeRichSend(bot, { kind: "chatMessage", chatId: 10, messageId: 5 })(rich());
  assert.equal(at(calls, 0).method, "editMessageText");
  assert.equal(at(calls, 0).params.chat_id, 10);
  assert.equal(at(calls, 0).params.message_id, 5);
  assert.equal("inline_message_id" in at(calls, 0).params, false);
});

test("makeRichSend: 'message is not modified' = успех, прочие ошибки пробрасываются", async () => {
  const nm = stubBot({
    editMessageText: new Error("Bad Request: message is not modified: specified new message content"),
  });
  await makeRichSend(nm.bot, { kind: "inline", inlineMessageId: "IM" })(rich());
  const bad = stubBot({ editMessageText: new Error("Bad Request: 400") });
  await assert.rejects(makeRichSend(bad.bot, { kind: "inline", inlineMessageId: "IM" })(rich()), /400/);
});

/** фабрика заказа для deliverCardAndTrack с журналом порядка вызовов. */
function setup(
  over: {
    card?: "ok" | "null" | "reject";
    track?: "ok" | "null";
    sendRich?: "ok" | "throw";
    fallbackThrows?: boolean;
  } = {},
) {
  const log: string[] = [];
  const fallbackArgs: unknown[] = [];
  const card: MintedCard = { fileId: "CARD", release: () => log.push("release") };
  const opts = {
    label: "np user=1 track=2",
    card: async () => {
      log.push("card");
      if (over.card === "null") return null;
      if (over.card === "reject") throw new Error("render boom");
      return card;
    },
    track: async () => {
      log.push("track");
      return over.track === "null" ? null : audio();
    },
    sendRich: async () => {
      log.push("sendRich");
      if (over.sendRich === "throw") {
        throw new TelegramError(
          { ok: false, error_code: 400, description: "Bad Request: 400" } as never,
          "sendRichMessage" as never,
          {} as never,
        );
      }
    },
    fallback: async (got: unknown) => {
      log.push("fallback");
      fallbackArgs.push(got);
      if (over.fallbackThrows) throw new Error("fb boom");
    },
  };
  return { opts, log, fallbackArgs };
}

test("deliver: оба есть, sendRich ок => rich; release один раз ПОСЛЕ sendRich; без warning", async (t) => {
  const lines = captureLog(t);
  const s = setup();
  assert.equal(await deliverCardAndTrack(s.opts), "rich");
  assert.deepEqual(
    s.log.filter((x) => x !== "card" && x !== "track"),
    ["sendRich", "release"],
  );
  assert.deepEqual(s.fallbackArgs, []);
  assert.equal(lines.filter((l) => l.includes("WARNING")).length, 0);
});

test("deliver: sendRich падает => fallback с обоими file_id, ровно один warning, release один раз, не бросает", async (t) => {
  const lines = captureLog(t);
  const s = setup({ sendRich: "throw" });
  assert.equal(await deliverCardAndTrack(s.opts), "fallback");
  assert.deepEqual(s.fallbackArgs, [{ cardFileId: "CARD", audio: audio() }]);
  assert.deepEqual(
    s.log.filter((x) => x === "release"),
    ["release"],
  );
  assert.ok(s.log.indexOf("release") > s.log.indexOf("fallback"));
  const warns = lines.filter((l) => l.includes("WARNING"));
  assert.equal(warns.length, 1);
  const w = warns[0] ?? "";
  assert.ok(w.includes("[rich]") && w.includes("np user=1 track=2") && w.includes("400"));
});

test("deliver: карточка отклонена => fallback без card, sendRich не вызван, один warning", async (t) => {
  const lines = captureLog(t);
  const s = setup({ card: "reject" });
  assert.equal(await deliverCardAndTrack(s.opts), "fallback");
  assert.deepEqual(s.fallbackArgs, [{ cardFileId: null, audio: audio() }]);
  assert.ok(!s.log.includes("sendRich"));
  assert.equal(lines.filter((l) => l.includes("WARNING")).length, 1);
});

test("deliver: трека нет => fallback({card}), release один раз", async () => {
  const s = setup({ track: "null" });
  assert.equal(await deliverCardAndTrack(s.opts), "fallback");
  assert.deepEqual(s.fallbackArgs, [{ cardFileId: "CARD", audio: null }]);
  assert.ok(!s.log.includes("sendRich"));
  assert.deepEqual(
    s.log.filter((x) => x === "release"),
    ["release"],
  );
});

test("deliver: ничего нет => none, fallback/sendRich не вызваны", async () => {
  const s = setup({ card: "null", track: "null" });
  assert.equal(await deliverCardAndTrack(s.opts), "none");
  assert.deepEqual(
    s.log.filter((x) => x === "fallback" || x === "sendRich" || x === "release"),
    [],
  );
});

test("deliver: сам fallback упал => none, исключение не уходит наружу, release вызван", async (t) => {
  captureLog(t);
  const s = setup({ sendRich: "throw", fallbackThrows: true });
  assert.equal(await deliverCardAndTrack(s.opts), "none");
  assert.ok(s.log.includes("release"));
});

test("deliver: card() и track() стартуют параллельно", async () => {
  const order: string[] = [];
  let resolveCard: (m: MintedCard | null) => void = () => {};
  const p = deliverCardAndTrack({
    label: "x",
    card: () => {
      order.push("card-start");
      return new Promise<MintedCard | null>((r) => {
        resolveCard = r;
      });
    },
    track: async () => {
      order.push("track-start");
      return audio();
    },
    sendRich: async () => {},
    fallback: async () => {},
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["card-start", "track-start"]);
  resolveCard({ fileId: "C", release() {} });
  assert.equal(await p, "rich");
});

test("логи не содержат токен бота", async (t) => {
  const lines = captureLog(t);
  const s = setup({ sendRich: "throw" });
  s.opts.sendRich = async () => {
    throw new Error("fail https://api.telegram.org/bot123456:ABC-def_ghi/sendRichMessage");
  };
  await deliverCardAndTrack(s.opts);
  assert.ok(!lines.join("").includes("123456:ABC"));
});

test("chatRichSenders.sendRich: один sendRichMessage с chat_id, rich_message, reply_markup", async () => {
  const { bot, calls } = stubBot();
  const { sendRich } = chatRichSenders(bot, 10, { trackId: "77", trackLayout: "button", botUsername: "nowbot" });
  await sendRich(rich());
  assert.equal(calls.length, 1);
  assert.equal(at(calls, 0).method, "sendRichMessage");
  assert.equal(at(calls, 0).params.chat_id, 10);
  assert.ok(JSON.stringify(at(calls, 0).params.reply_markup).includes("like:t:77"));
});

test("chatRichSenders.fallback: sendPhoto (карточка + start=track_) затем sendAudio", async () => {
  const { bot, calls } = stubBot();
  const { fallback } = chatRichSenders(bot, 10, { trackId: "77", trackLayout: "button", botUsername: "nowbot" });
  await fallback({ cardFileId: "CARD", audio: audio() });
  assert.deepEqual(
    calls.map((c) => c.method),
    ["sendPhoto", "sendAudio"],
  );
  assert.equal(at(calls, 0).params.photo, "CARD");
  assert.ok(JSON.stringify(at(calls, 0).params.reply_markup).includes("start=track_77"));
  assert.equal(at(calls, 1).params.audio, "AUD");
  assert.equal("caption" in at(calls, 1).params, false);
});

test("chatRichSenders.fallback: только трек (degraded) => один sendAudio с подписью", async () => {
  const { bot, calls } = stubBot();
  const { fallback } = chatRichSenders(bot, 10, { trackId: "77", trackLayout: "button", botUsername: "nowbot" });
  await fallback({ cardFileId: null, audio: audio({ degraded: true }) });
  assert.deepEqual(
    calls.map((c) => c.method),
    ["sendAudio"],
  );
  assert.equal(at(calls, 0).params.caption, DEGRADED_NOTE);
});
