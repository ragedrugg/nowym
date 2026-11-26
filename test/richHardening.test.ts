/** F3: харденинг rich-сообщений: двойная отправка, 429, утечка токена, chosen npr:. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramError } from "gramio";
import type { Container } from "../src/bot/container.ts";
import { renderNowPlaying } from "../src/bot/handlers/common.ts";
import { chosenRichCardTrack, sendTrackToChat } from "../src/bot/handlers/inline.ts";
import { buildRichNowPlayingResult, resolveRichCard } from "../src/bot/handlers/inlineCard.ts";
import * as rich from "../src/bot/richMessage.ts";
import type { YaTrack } from "../src/yandex/types.ts";

type Call = { method: string; params: Record<string, unknown> };
const SECRET = "bot123456:ABC-secret";

const tgErr = (code: number, description: string, parameters?: { retry_after?: number }, method = "sendRichMessage") =>
  new TelegramError({ ok: false, error_code: code, description, parameters } as never, method as never, {} as never);
const netErr = () => Object.assign(new Error(`fetch failed ${SECRET}`), { name: "TypeError" });
const abortErr = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

function captureLog(t: { mock: { method: (o: object, m: "write", f: never) => unknown } }): string[] {
  const lines: string[] = [];
  const f = ((s: string | Uint8Array) => {
    lines.push(String(s));
    return true;
  }) as never;
  t.mock.method(process.stdout, "write", f);
  t.mock.method(process.stderr, "write", f);
  return lines;
}

const track = (id = 777): YaTrack => ({ id, title: "Song", artists: [{ name: "Artist" }], durationMs: 200000 });
const audio: rich.RichAudio = { fileId: "AUD", title: "S", performer: "A", durationSec: 200, degraded: false };

// ---------- deliverCardAndTrack: когда фолбэк, когда нет ----------

function deliverOpts(sendRich: (r: unknown) => Promise<void>) {
  const log: string[] = [];
  return {
    log,
    opts: {
      label: "np user=1 track=2",
      card: async () => ({ fileId: "CARD", release: () => log.push("release") }),
      track: async () => audio,
      sendRich: async (r: unknown) => {
        log.push("sendRich");
        await sendRich(r);
      },
      fallback: async () => {
        log.push("fallback");
      },
    } as Parameters<typeof rich.deliverCardAndTrack>[0],
  };
}

test("deliver: 404 'method not found' (TelegramError) => фолбэк", async (t) => {
  captureLog(t);
  const d = deliverOpts(async () => {
    throw tgErr(404, "Not Found: method not found");
  });
  assert.equal(await rich.deliverCardAndTrack(d.opts), "fallback");
  assert.deepEqual(
    d.log.filter((x) => x === "fallback"),
    ["fallback"],
  );
});

test("deliver: 400 (TelegramError) => фолбэк", async (t) => {
  captureLog(t);
  const d = deliverOpts(async () => {
    throw tgErr(400, "Bad Request: unsupported");
  });
  assert.equal(await rich.deliverCardAndTrack(d.opts), "fallback");
  assert.ok(d.log.includes("fallback"));
});

for (const [name, mk] of [
  ["сеть (fetch failed)", netErr],
  ["таймаут/abort", abortErr],
] as const) {
  test(`deliver: ${name} => НЕТ фолбэка (нет дубля), результат "unknown", один warning, release вызван`, async (t) => {
    const lines = captureLog(t);
    const d = deliverOpts(async () => {
      throw mk();
    });
    const res = await rich.deliverCardAndTrack(d.opts);
    assert.equal(res as string, "unknown");
    assert.equal(d.log.includes("fallback"), false);
    assert.ok(d.log.includes("release"));
    assert.equal(lines.filter((l) => l.includes("WARNING")).length, 1);
  });
}

// ---------- 429 ----------

test("deliver: 429 на sendRich ретраится (retry_after=0) и затем успех, фолбэка нет", async (t) => {
  captureLog(t);
  let n = 0;
  const d = deliverOpts(async () => {
    if (++n === 1) throw tgErr(429, "Too Many Requests", { retry_after: 0 });
  });
  assert.equal(await rich.deliverCardAndTrack(d.opts), "rich");
  assert.equal(n, 2);
  assert.equal(d.log.includes("fallback"), false);
});

test("deliver: 429 без конца => ровно 3 попытки, затем фолбэк (определённая ошибка API)", async (t) => {
  captureLog(t);
  let n = 0;
  const d = deliverOpts(async () => {
    n++;
    throw tgErr(429, "Too Many Requests", { retry_after: 0 });
  });
  assert.equal(await rich.deliverCardAndTrack(d.opts), "fallback");
  assert.equal(n, 3);
});

// ---------- токен в логах ----------

test("errText экспортирован и маскирует токен", () => {
  const s = rich.errText(new Error(`boom https://api.telegram.org/${SECRET}/x`));
  assert.ok(!s.includes("123456:ABC"));
  assert.ok(s.includes("bot<token>"));
});

function mkBot(o: { rich?: "ok" | "tg400" | "tg404" | "net" | "abort"; markupFails?: boolean } = {}) {
  const calls: Call[] = [];
  const rec =
    (method: string, ret: unknown = true) =>
    async (params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "sendRichMessage" || method === "editMessageText") {
        if (o.rich === "tg400") throw tgErr(400, "Bad Request: rich");
        if (o.rich === "tg404") throw tgErr(404, "Not Found: method not found");
        if (o.rich === "net") throw netErr();
        if (o.rich === "abort") throw abortErr();
      }
      if (method === "editMessageReplyMarkup" && o.markupFails) throw new Error(`markup ${SECRET} down`);
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
      editMessageMedia: rec("editMessageMedia"),
      editMessageReplyMarkup: rec("editMessageReplyMarkup"),
      sendMessage: rec("sendMessage"),
    },
  };
  return { bot: bot as never, calls };
}

function mkContainer(o: { token?: "ok" | "throw"; settingsThrow?: boolean; limiterThrow?: boolean } = {}) {
  const renders: unknown[] = [];
  const yaTrack = track();
  const container = {
    botUsername: "nowymbot",
    channelId: "chan",
    inlineOwners: new Map(),
    inlineEffects: new Map(),
    downloadLimiter: {
      check: () => {
        if (o.limiterThrow) throw new Error(`limiter ${SECRET}`);
        return [true, 0];
      },
    },
    resolveToken: async () => {
      if (o.token === "throw") throw new Error(`redis ${SECRET} down`);
      return "tok";
    },
    getUserSettings: async () => {
      if (o.settingsThrow) throw new Error(`settings ${SECRET} down`);
      return {
        rich_messages: true,
        track_layout: "button",
        track_quality: "best",
        card_toggles: { avatar: false },
        card_progress: "bar",
        card_style: "dark",
        card_aspect: "square",
      };
    },
    getTrackService: async () => ({ getTrackObject: () => yaTrack, cacheTrackObject() {} }),
    getYandexService: async () => ({ reportPlayback: async () => {}, getCurrentTrack: async () => null }),
    cacheDb: {
      get: async () => ({ telegram_file_id: "FID", is_cached: true, codec: "mp3", bitrate_kbps: 320, duration: 200 }),
    },
    cardRenderPool: {
      render: async (a: unknown) => {
        renders.push(a);
        return Buffer.from("jpg");
      },
    },
    npWatcher: null,
  } as unknown as Container;
  return { container, renders };
}

const stash = (container: Container, userId = 1) =>
  (buildRichNowPlayingResult(container, track(), { progress_ms: 5000 }, { id: userId }) as { id: string }).id;
const methods = (calls: Call[]) => calls.map((c) => c.method);
const user = { id: 1, username: "u" };
const card = { progressMs: 42000, durationMs: 200000, paused: false };

test("логи resolveRichCard (retry-разметка, общий catch) не содержат токен", async (t) => {
  const lines = captureLog(t);
  const { container } = mkContainer({ settingsThrow: true });
  const { bot } = mkBot({ markupFails: true });
  await resolveRichCard(bot, container, stash(container), "IM", async () => audio);
  await resolveRichCard(bot, container, "npr:1:777:99", "IM", async () => audio); // нет стэша
  const all = lines.join("");
  assert.ok(all.includes("[rich]") || all.includes("[chosen]"), "что-то залогировано");
  assert.ok(!all.includes("123456:ABC"));
});

test("лог rich-плейсхолдера (buildEmptyResults) и /np не содержат токен", async (t) => {
  const lines = captureLog(t);
  const { buildEmptyResults } = await import("../src/bot/handlers/inline.ts");
  const container = {
    botUsername: "nowymbot",
    npWatcher: {
      ownerId: 1,
      getCurrentSnapshot: () => ({ track: track(), progress_ms: 1000, duration_ms: 200000, paused: false }),
    },
  } as unknown as Container;
  // trackCardBasics бросает на мусорном треке => ветка catch rich-плейсхолдера
  const badTrack = {
    get id(): number {
      throw new Error(`placeholder ${SECRET}`);
    },
    title: "x",
    artists: [],
  };
  container.npWatcher!.getCurrentSnapshot = (() => ({
    track: badTrack,
    progress_ms: 1,
    duration_ms: 2,
    paused: false,
  })) as never;
  const ts = {
    cacheTrackObject() {},
    createInlineResultFromTrack: async () => null,
    recentResultsPaged: async () => ({ results: [], nextOffset: "" }),
  } as never;
  await buildEmptyResults(
    container,
    ts,
    { id: 1 },
    { layout: "button", cardLayout: "button", sendMode: "x", richMessages: true },
  );
  assert.ok(lines.join("").includes("rich-плейсхолдер"));
  assert.ok(!lines.join("").includes("123456:ABC"));

  const { container: c2 } = mkContainer({ settingsThrow: true });
  (c2 as unknown as { getYandexService: unknown }).getYandexService = async () => ({
    getCurrentTrack: async () => {
      throw new Error(`np ${SECRET} down`);
    },
  });
  await renderNowPlaying(mkBot().bot, 10, user, c2, null);
  assert.ok(!lines.join("").includes("123456:ABC"));
});

// ---------- чат: сеть/таймаут не даёт дубль ----------

for (const mode of ["net", "abort"] as const) {
  test(`sendTrackToChat: rich ${mode} => один sendRichMessage, НЕТ sendPhoto/sendAudio в чат (нет дубля)`, async (t) => {
    captureLog(t);
    const { container } = mkContainer();
    const { bot, calls } = mkBot({ rich: mode });
    await sendTrackToChat({ bot, chatId: 10, userId: 1, user, container, trackId: "777", statusMsgId: 5, card });
    assert.equal(calls.filter((c) => c.method === "sendRichMessage").length, 1);
    assert.equal(
      calls.filter((c) => c.params.chat_id === 10 && (c.method === "sendPhoto" || c.method === "sendAudio")).length,
      0,
    );
  });
}

for (const [mode, code] of [
  ["tg404", 404],
  ["tg400", 400],
] as const) {
  test(`sendTrackToChat: rich ${code} (ответ API) => фолбэк sendPhoto(CARD)+sendAudio(AUD) с полными параметрами`, async (t) => {
    captureLog(t);
    const { container } = mkContainer();
    const { bot, calls } = mkBot({ rich: mode });
    await sendTrackToChat({ bot, chatId: 10, userId: 1, user, container, trackId: "777", statusMsgId: 5, card });
    const sent = calls.filter((c) => c.params.chat_id === 10 && (c.method === "sendPhoto" || c.method === "sendAudio"));
    assert.deepEqual(methods(sent), ["sendPhoto", "sendAudio"]);
    assert.equal(sent[0]!.params.photo, "CARD");
    assert.ok(JSON.stringify(sent[0]!.params.reply_markup).includes("start=track_777"));
    assert.deepEqual(sent[1]!.params, { chat_id: 10, audio: "FID" });
  });
}

// ---------- inline: неизвестный исход ----------

test("resolveRichCard: сеть/таймаут на inline-правке => без editMessageMedia и без смены разметки, результат unknown", async (t) => {
  captureLog(t);
  const { container } = mkContainer();
  const { bot, calls } = mkBot({ rich: "net" });
  const res = await resolveRichCard(bot, container, stash(container), "IM", async () => audio);
  assert.equal(res as string, "unknown");
  assert.equal(methods(calls).includes("editMessageMedia"), false);
  assert.equal(methods(calls).includes("editMessageReplyMarkup"), false);
});

test("resolveRichCard: 404 на inline-правке (ответ API) => фолбэк editMessageMedia", async (t) => {
  captureLog(t);
  const { container } = mkContainer();
  const { bot, calls } = mkBot({ rich: "tg404" });
  const res = await resolveRichCard(bot, container, stash(container), "IM", async () => audio);
  assert.equal(res, "fallback");
  assert.ok(methods(calls).includes("editMessageMedia"));
});

test("makeRichSend: 'message is not modified' остаётся успехом", async () => {
  const { bot } = mkBot();
  (bot as { api: { editMessageText: unknown } }).api.editMessageText = async () => {
    throw tgErr(400, "Bad Request: message is not modified", undefined, "editMessageText");
  };
  await rich.makeRichSend(bot, { kind: "inline", inlineMessageId: "IM" })({ blocks: [] });
});

// ---------- chosen npr: ----------

test("chosen npr: resolveToken бросает => retry-разметка (load:), без рендера, не бросает наружу", async (t) => {
  captureLog(t);
  const { container, renders } = mkContainer({ token: "throw" });
  const { bot, calls } = mkBot();
  await chosenRichCardTrack(bot, container, stash(container), "IM", 1);
  assert.equal(renders.length, 0);
  const kb = calls.find((c) => c.method === "editMessageReplyMarkup");
  assert.ok(kb && JSON.stringify(kb.params.reply_markup).includes("load:777"));
});

test("chosen npr: limiter бросает => тоже retry-разметка", async (t) => {
  const lines = captureLog(t);
  const { container } = mkContainer({ limiterThrow: true });
  const { bot, calls } = mkBot();
  await chosenRichCardTrack(bot, container, stash(container), "IM", 1);
  assert.ok(calls.some((c) => c.method === "editMessageReplyMarkup"));
  assert.ok(!lines.join("").includes("123456:ABC"));
});

test("chosen npr: userId стэша != userId chosen => как протухший стэш: без рендера и rich, retry-разметка", async (t) => {
  captureLog(t);
  const { container, renders } = mkContainer();
  const { bot, calls } = mkBot();
  await chosenRichCardTrack(bot, container, stash(container, 2), "IM", 1);
  assert.equal(renders.length, 0);
  assert.equal(methods(calls).includes("editMessageText"), false);
  const kb = calls.find((c) => c.method === "editMessageReplyMarkup");
  assert.ok(kb && JSON.stringify(kb.params.reply_markup).includes("load:777"));
});
