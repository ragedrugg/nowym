/** F1 L5: rich-плейсхолдер первым в инлайн-выдаче и его разрешение на chosen_inline_result. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramError } from "gramio";
import type { Container } from "../src/bot/container.ts";
import { buildEmptyResults, chosenRichCardTrack, onChosenResult } from "../src/bot/handlers/inline.ts";
import { buildRichNowPlayingResult } from "../src/bot/handlers/inlineCard.ts";
import { tooOftenButton } from "../src/bot/texts.ts";
import { YandexUnavailableError } from "../src/yandex/client.ts";
import type { YaTrack } from "../src/yandex/types.ts";

type Call = { method: string; params: Record<string, unknown> };

const track = (id = 777): YaTrack => ({ id, title: "Song", artists: [{ name: "Artist" }], durationMs: 200000 });

function mkBot(opts: { failEditText?: boolean } = {}) {
  const calls: Call[] = [];
  const rec =
    (method: string, ret: unknown = true) =>
    async (params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "editMessageText" && opts.failEditText)
        throw new TelegramError(
          { ok: false, error_code: 400, description: "Bad Request" } as never,
          "editMessageText" as never,
          {} as never,
        );
      return ret;
    };
  const bot = {
    api: {
      sendPhoto: rec("sendPhoto", { message_id: 9, photo: [{ file_id: "CARD" }] }),
      deleteMessage: rec("deleteMessage"),
      editMessageText: rec("editMessageText"),
      editMessageMedia: rec("editMessageMedia"),
      editMessageReplyMarkup: rec("editMessageReplyMarkup"),
    },
  };
  return { bot: bot as never, calls };
}

// --- buildEmptyResults ---

function mkQueryFixture(playing: boolean) {
  const container = {
    botUsername: "nowymbot",
    npWatcher: {
      ownerId: 1,
      getCurrentSnapshot: () =>
        playing ? { track: track(), progress_ms: 61000, duration_ms: 200000, paused: false } : null,
    },
  } as unknown as Container;
  const trackService = {
    cacheTrackObject() {},
    createInlineResultFromTrack: async () => ({ id: "tm:777" }),
    recentResultsPaged: async () => ({ results: [], nextOffset: "" }),
  } as never;
  return { container, trackService };
}

const ids = (r: { results: unknown[] }) => r.results.map((x) => (x as { id: string }).id);
const base = { layout: "button", cardLayout: "button", sendMode: "text_media" };

test("buildEmptyResults: rich ON + играет: npr: первым, затем tm: и npc:", async () => {
  const { container, trackService } = mkQueryFixture(true);
  const r = await buildEmptyResults(container, trackService, { id: 1 }, { ...base, richMessages: true });
  assert.deepEqual(ids(r), ["npr:1:777:61", "tm:777", "npc:1:777:61"]);
});

test("[regression guard] buildEmptyResults: rich OFF/не задан: ровно старый вывод без npr:", async () => {
  const { container, trackService } = mkQueryFixture(true);
  const off = await buildEmptyResults(container, trackService, { id: 1 }, { ...base, richMessages: false });
  const unset = await buildEmptyResults(container, trackService, { id: 1 }, base);
  assert.deepEqual(ids(off), ["tm:777", "npc:1:777:61"]);
  assert.deepEqual(ids(unset), ["tm:777", "npc:1:777:61"]);
  assert.deepEqual(off, unset, "OFF и не задан дают идентичный полный вывод");
  assert.ok(!JSON.stringify(off).includes("npr:"));
  const npc = off.results[1] as { input_message_content?: unknown; reply_markup?: unknown };
  assert.ok(npc.input_message_content && npc.reply_markup, "npc: плейсхолдер как раньше (текст + разметка)");
});

test("buildEmptyResults: rich ON, ничего не играет: без изменений", async () => {
  const { container, trackService } = mkQueryFixture(false);
  const r = await buildEmptyResults(container, trackService, { id: 1 }, { ...base, richMessages: true });
  assert.deepEqual(ids(r), []);
});

// --- chosen ---

function mkChosenContainer(o: { allowed?: boolean; token?: string | null; failRender?: boolean } = {}) {
  const renders: { progressMs: number }[] = [];
  const dbCalls: unknown[] = [];
  const owners = new Map<string, number>();
  const yaTrack = track();
  const container = {
    botUsername: "nowymbot",
    channelId: "chan",
    inlineOwners: owners,
    inlineEffects: new Map(),
    downloadLimiter: { check: () => (o.allowed === false ? [false, 7.2] : [true, 0]) },
    resolveToken: async () => (o.token === undefined ? "tok" : o.token),
    getUserSettings: async () => ({
      track_layout: "button",
      track_quality: "best",
      card_toggles: { avatar: false },
      card_progress: "bar",
      card_style: "dark",
      card_aspect: "square",
    }),
    getTrackService: async () => ({ getTrackObject: () => yaTrack, cacheTrackObject() {} }),
    getYandexService: async () => ({}),
    cacheDb: {
      get: async (id: string, tier?: string) => {
        dbCalls.push([id, tier]);
        return { telegram_file_id: "FID", is_cached: true, codec: "mp3", bitrate_kbps: 320, duration: 200 };
      },
    },
    cardRenderPool: {
      render: async (a: { progressMs: number }) => {
        if (o.failRender) throw new Error("pool down");
        renders.push(a);
        return Buffer.from("jpg");
      },
    },
  } as unknown as Container;
  return { container, renders, dbCalls, owners };
}

const stash = (container: Container, userId = 1, progressMs = 5000) =>
  (buildRichNowPlayingResult(container, track(), { progress_ms: progressMs }, { id: userId }) as { id: string }).id;

test("chosen npr по ссылке на трек: hideProgress доходит до рендера; обычная npr — нет", async () => {
  const link = mkChosenContainer();
  const lid = (
    buildRichNowPlayingResult(link.container, track(), { duration_ms: 200000 }, { id: 1 }, true) as { id: string }
  ).id;
  await chosenRichCardTrack(mkBot().bot, link.container, lid, "IM", 1);
  await new Promise((r) => setImmediate(r));
  assert.equal((link.renders[0] as { hideProgress?: boolean }).hideProgress, true);

  const np = mkChosenContainer();
  await chosenRichCardTrack(mkBot().bot, np.container, stash(np.container), "IM", 1);
  await new Promise((r) => setImmediate(r));
  assert.equal((np.renders[0] as { hideProgress?: boolean }).hideProgress, false);
});

test("chosen npr: getAudio идёт через ensureFileId, rich edit [photo, audio], позиция заморожена", async () => {
  const { container, renders, dbCalls } = mkChosenContainer();
  const { bot, calls } = mkBot();
  await chosenRichCardTrack(bot, container, stash(container), "IM", 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(renders[0]!.progressMs, 5000);
  assert.ok(dbCalls.length > 0, "resolveTrack/ensureFileId ходили в cacheDb");
  const edit = calls.find((c) => c.method === "editMessageText")!;
  const blocks = (
    edit.params.rich_message as {
      blocks: { type: string; photo?: { media: string }; audio?: Record<string, unknown> }[];
    }
  ).blocks;
  assert.equal(blocks[0]!.photo!.media, "CARD");
  assert.equal(blocks[1]!.audio!.media, "FID");
  assert.equal(blocks[1]!.audio!.title, "Song");
  assert.equal(blocks[1]!.audio!.performer, "Artist");
  assert.equal(blocks[1]!.audio!.duration, 200);
  assert.equal(edit.params.inline_message_id, "IM");
});

test("chosen npr: лимитер отказал: без рендера, плейсхолдер получает 'слишком часто' с load:", async () => {
  const { container, renders } = mkChosenContainer({ allowed: false });
  const { bot, calls } = mkBot();
  await chosenRichCardTrack(bot, container, stash(container), "IM", 1);
  assert.equal(renders.length, 0);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["editMessageReplyMarkup"],
  );
  const kb = JSON.stringify(calls[0]!.params.reply_markup);
  assert.ok(kb.includes(tooOftenButton(7.2)), "лимит-кнопка каноничным текстом");
  assert.ok(kb.includes("подожди 8 сек"), "retryAfter 7.2 → вверх, 8 (D12)");
  assert.ok(kb.includes("load:777"));
});

test("chosen npr: нет стэша (вытеснен): retry-разметка, без рендера", async () => {
  const { container, renders } = mkChosenContainer();
  const { bot, calls } = mkBot();
  await chosenRichCardTrack(bot, container, "npr:1:777:99", "IM", 1);
  assert.equal(renders.length, 0);
  assert.ok(JSON.stringify(calls[0]!.params.reply_markup).includes("load:777"));
});

test("chosen npr: нет токена: retry-разметка, без рендера", async () => {
  const { container, renders } = mkChosenContainer({ token: null });
  const { bot, calls } = mkBot();
  await chosenRichCardTrack(bot, container, stash(container), "IM", 1);
  assert.equal(renders.length, 0);
  assert.ok(JSON.stringify(calls[0]!.params.reply_markup).includes("load:777"));
});

test("chosen npr: rich edit упал: фолбэк на фото карточки, не бросает", async () => {
  const { container } = mkChosenContainer();
  const { bot, calls } = mkBot({ failEditText: true });
  await chosenRichCardTrack(bot, container, stash(container), "IM", 1);
  const media = calls.find((c) => c.method === "editMessageMedia")!;
  assert.equal((media.params.media as { type: string }).type, "photo");
});

test("chosen npr: и карточка, и трек не вышли: retry-разметка", async () => {
  const { container } = mkChosenContainer({ failRender: true });
  const c = container as unknown as Record<string, unknown>;
  (c.cacheDb as { get: () => Promise<null> }).get = async () => null;
  c.getTrackService = async () => ({ getTrackObject: () => null, cacheTrackObject() {} });
  c.getYandexService = async () => ({ getTrackById: async () => null });
  const { bot, calls } = mkBot();
  await chosenRichCardTrack(bot, container, stash(container), "IM", 1);
  const kb = calls.find((x) => x.method === "editMessageReplyMarkup")!;
  assert.ok(JSON.stringify(kb.params.reply_markup).includes("load:777"));
});

test("onChosenResult npr: владелец пишется в inlineOwners, идёт rich-ветка, не npc-карточка", async () => {
  const { container, owners, renders } = mkChosenContainer();
  const { bot, calls } = mkBot();
  await onChosenResult({ from: { id: 1 }, resultId: stash(container), inlineMessageId: "IM" }, container, bot);
  await new Promise((r) => setImmediate(r));
  assert.equal(owners.get("IM"), 1);
  assert.equal(renders.length, 1);
  assert.ok(calls.some((c) => c.method === "editMessageText"));
  assert.equal(
    calls.some((c) => c.method === "editMessageMedia"),
    false,
  );
});

test("chosen npr: сбой Яндекса (strict getTrackById), трек в кэше → rich [карточка, кэш-аудио]", async () => {
  const { container } = mkChosenContainer();
  const c = container as unknown as Record<string, unknown>;
  c.getTrackService = async () => ({ getTrackObject: () => null, cacheTrackObject() {} });
  c.getYandexService = async () => ({
    getTrackById: async () => {
      throw new YandexUnavailableError("down", new Error("503"));
    },
  });
  const { bot, calls } = mkBot();
  await chosenRichCardTrack(bot, container, stash(container), "IM", 1);
  await new Promise((r) => setImmediate(r));
  const edit = calls.find((x) => x.method === "editMessageText")!;
  const blocks = (edit.params.rich_message as { blocks: { audio?: { media: string } }[] }).blocks;
  assert.equal(blocks[1]!.audio!.media, "FID");
});
