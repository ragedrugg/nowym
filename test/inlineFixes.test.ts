/** inline: копии кэша выдачи, лимитер только на закачке, тир economy, лайк-тоггл, эффект+ссылка, «partial». */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Container } from "../src/bot/container.ts";
import {
  ensureFileId,
  injectRichSearchCards,
  injectTrackLinkCards,
  onChosenResult,
  registerInline,
} from "../src/bot/handlers/inline/index.ts";
import { buildNowPlayingCardResult, renderAndSwapCard } from "../src/bot/handlers/inlineCard.ts";
import { chatRichSenders, deliverCardAndTrack, PartialDeliveryError } from "../src/bot/richMessage.ts";
import { TTLCache } from "../src/infra/memoryCache.ts";
import { type InlineResult, SearchService } from "../src/services/search.ts";
import type { CachedTrack } from "../src/storage/types.ts";
import type { YaTrack } from "../src/yandex/types.ts";

type Call = { method: string; params: Record<string, unknown> };

function mkBot(failing: string[] = []) {
  const calls: Call[] = [];
  const make = (method: string) => async (params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (failing.includes(method)) throw new Error(`${method} boom`);
    return { message_id: 1 };
  };
  const bot = {
    api: {
      sendPhoto: make("sendPhoto"),
      sendAudio: make("sendAudio"),
      editMessageReplyMarkup: make("editMessageReplyMarkup"),
      editMessageMedia: make("editMessageMedia"),
    },
  };
  return { bot: bot as never, calls };
}

const track = (id = 42): YaTrack => ({ id, title: "Song", artists: [{ name: "A" }], durationMs: 200000 });

// ---------- 1. кэш выдачи не делится мутируемым массивом ----------

test("searchAndCreateResults: и попадание в кэш, и сохранённое — копии (вставка карточки не течёт)", async () => {
  const cache = new TTLCache<InlineResult[]>(10, 300, 3600);
  const yandex = { getAlbumShort: async () => ({ id: 5, title: "Alb", artists: [], trackCount: 1 }) };
  const svc = new SearchService(yandex as never, cache, {} as never, "nowymbot", 1);
  const q = "https://music.yandex.ru/album/5";

  const first = await svc.searchAndCreateResults(q);
  assert.equal(first.length, 1);
  first.push({ id: "junk" } as never); // как это делает injectTrackLinkCards
  const second = await svc.searchAndCreateResults(q);
  assert.equal(second.length, 1, "мутация первого массива не должна попасть в кэш");
  second.unshift({ id: "junk2" } as never);
  const third = await svc.searchAndCreateResults(q);
  assert.equal(third.length, 1, "мутация копии из кэша не должна попасть в кэш");
  await cache.close();
});

// ---------- 10. эффект + ссылка ----------

test("injectTrackLinkCards: «ncore <ссылка>» карточки не вставляет, обычная ссылка — вставляет", () => {
  const t = track(42);
  const trackService = { getTrackObject: () => t } as never;
  const container = { botUsername: "nowymbot" } as never;
  const link = "https://music.yandex.ru/album/1/track/42";
  const mk = () => [{ id: "42" }] as unknown[];

  const withEffect = mk();
  injectTrackLinkCards(
    container,
    trackService,
    { id: 1 },
    { text: `ncore ${link}`, richMessages: true, cardLayout: "button" },
    withEffect,
  );
  assert.equal(withEffect.length, 1);

  const plain = mk();
  injectTrackLinkCards(
    container,
    trackService,
    { id: 1 },
    { text: link, richMessages: false, cardLayout: "button" },
    plain,
  );
  assert.equal(plain.length, 2);
});

// ---------- поиск по названию: «карточка + трек» перед каждым треком ----------

test("injectRichSearchCards: при rich_messages перед каждым треком встаёт npr-карточка, альбомы не трогаем", () => {
  // getTrackObject получает id уже без префикса «tm:» (его снимает parseTrackResultId)
  const tracks: Record<string, YaTrack> = { "1": track(1), "2": track(2) };
  const trackService = {
    getTrackObject: (id: string) => tracks[id] ?? null,
  } as never;
  const container = { botUsername: "nowymbot" } as never;
  const mk = () => [{ id: "1" }, { id: "tm:2" }, { id: "album:9" }] as unknown[];

  const rich = mk();
  injectRichSearchCards(container, trackService, { id: 7 }, { richMessages: true, isPagedSearch: true }, rich);
  assert.deepEqual(
    rich.map(
      (r) =>
        String((r as { id: string }).id)
          .split(":")
          .slice(0, 1)[0],
    ),
    ["npr", "1", "npr", "tm", "album"],
    "карточка+трек идёт ПЕРЕД аудио, альбом остаётся как есть",
  );
  assert.match(String((rich[0] as { id: string }).id), /^npr:7:1:0$/);

  const off = mk();
  injectRichSearchCards(container, trackService, { id: 7 }, { richMessages: false, isPagedSearch: true }, off);
  assert.equal(off.length, 3, "настройка выключена — выдача не меняется");

  const notSearch = mk();
  injectRichSearchCards(container, trackService, { id: 7 }, { richMessages: true, isPagedSearch: false }, notSearch);
  assert.equal(notSearch.length, 3, "не поиск по названию (ссылка, лирика, эффект, недавнее) — не трогаем");
});

// ---------- 2. лимитер: кэшированное не тратит ----------

function chosenContainer(opts: { cached: CachedTrack | null; limiterAllows: boolean; quality?: string }) {
  let limiterCalls = 0;
  const t = track(42);
  const container = {
    botUsername: "nowymbot",
    inlineOwners: new Map<string, number>(),
    inlineEffects: new Map<string, string>(),
    downloadLimiter: {
      check: () => {
        limiterCalls++;
        return [opts.limiterAllows, 7] as [boolean, number];
      },
    },
    resolveToken: async () => "tok",
    getUserSettings: async () => ({ track_quality: opts.quality ?? "best", track_layout: "button" }),
    getTrackService: async () => ({ getTrackObject: () => t, cacheTrackObject: () => undefined }),
    getYandexService: async () => ({}),
    cacheDb: { get: async () => opts.cached },
  } as unknown as Container;
  return { container, limiterCalls: () => limiterCalls };
}

const cachedRow = {
  telegram_file_id: "F",
  is_cached: true,
  codec: "mp3",
  bitrate_kbps: 320,
  artist: "A",
  title: "S",
} as CachedTrack;

test("chosen: закэшированный трек не трогает лимитер и ставит кнопки готового аудио", async () => {
  const { container, limiterCalls } = chosenContainer({ cached: cachedRow, limiterAllows: false });
  const { bot, calls } = mkBot();
  await onChosenResult({ from: { id: 1 }, resultId: "42", inlineMessageId: "IM", query: "song" }, container, bot);
  assert.equal(limiterCalls(), 0);
  const last = calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1)!;
  assert.ok(!JSON.stringify(last.params.reply_markup).includes("слишком часто"));
});

test("chosen: реальная закачка упирается в лимитер → «слишком часто» вместо скачивания", async () => {
  const { container, limiterCalls } = chosenContainer({ cached: null, limiterAllows: false });
  const { bot, calls } = mkBot();
  await onChosenResult({ from: { id: 1 }, resultId: "42", inlineMessageId: "IM", query: "song" }, container, bot);
  assert.equal(limiterCalls(), 1);
  const last = calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1)!;
  assert.ok(JSON.stringify(last.params.reply_markup).includes("слишком часто"));
});

test("chosen: нет токена → кнопка с подсказкой про /login, не тишина", async () => {
  const { container } = chosenContainer({ cached: null, limiterAllows: true });
  (container as unknown as { resolveToken: () => Promise<null> }).resolveToken = async () => null;
  const { bot, calls } = mkBot();
  await onChosenResult({ from: { id: 1 }, resultId: "42", inlineMessageId: "IM", query: "song" }, container, bot);
  const last = calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1)!;
  assert.ok(JSON.stringify(last.params.reply_markup).includes("/login"));
});

// ---------- 3. тир economy ----------

test("ensureFileId(economy): ищет и качает в своём тире, lossy-кэш не подменяет", async () => {
  const gets: (string | undefined)[] = [];
  const puts: unknown[] = [];
  const container = {
    cacheDb: {
      get: async (_id: string, tier?: string) => {
        gets.push(tier);
        return null;
      },
    },
    cacheService: {
      downloadAndCacheTrack: async (...args: unknown[]) => {
        puts.push(args[4]);
        return "FID_ECO";
      },
    },
  } as unknown as Container;
  const yandex = {
    enrichStub: true,
    getBestDownloadInfo: async () => ({ codec: "mp3", bitrateInKbps: 192 }),
    directLinkFromInfo: async () => "u",
    getAlbumWithTracks: async () => null,
  } as never;
  const res = await ensureFileId(container, cachedRow, track(42), yandex, "42", { quality: "economy" });
  assert.deepEqual(gets.slice(0, 1), ["economy"]);
  assert.deepEqual(puts, ["economy"]);
  assert.equal(res.ok && res.fileId, "FID_ECO");
});

test("ensureFileId(economy): готовая economy-запись отдаётся без закачки", async () => {
  const container = {
    cacheDb: {
      get: async (_id: string, tier?: string) =>
        tier === "economy" ? { ...cachedRow, telegram_file_id: "ECO" } : null,
    },
  } as unknown as Container;
  const res = await ensureFileId(container, cachedRow, track(42), {} as never, "42", { quality: "economy" });
  assert.equal(res.ok && res.fileId, "ECO");
});

// ---------- 4. lossless-фолбэк берёт готовый lossy ----------

test("ensureFileId(lossless): lossless недоступен, lossy уже в кэше → отдаём его как degraded, без закачки mp3", async () => {
  let downloads = 0;
  const container = {
    cacheDb: { get: async (_id: string, tier?: string) => (tier === "lossy" ? cachedRow : null) },
    cacheService: {
      downloadAndCacheTrack: async () => {
        downloads++;
        return "X";
      },
    },
  } as unknown as Container;
  const yandex = {
    getBestDownloadInfo: async () => null,
    getLosslessDownload: async () => null,
    getAlbumWithTracks: async () => null,
  } as never;
  const res = await ensureFileId(container, null, track(42), yandex, "42", { quality: "lossless" });
  assert.equal(downloads, 0);
  assert.ok(res.ok && res.degraded && res.fileId === "F");
});

// ---------- 6. стэш карточки: промах и чужой пользователь ----------

test("renderAndSwapCard: стэша нет → кнопка «загрузить снова» по trackId из result_id", async () => {
  const { bot, calls } = mkBot();
  await renderAndSwapCard(bot, {} as never, "npc:1:555:12", "IM", 1);
  assert.equal(calls.length, 1);
  assert.ok(JSON.stringify(calls[0]!.params.reply_markup).includes("load:555"));
});

test("renderAndSwapCard: стэш чужого пользователя → не рендерим, ставим retry", async () => {
  const container = { botUsername: "nowymbot" } as never;
  const r = buildNowPlayingCardResult(container, track(556), { progress_ms: 0 }, { id: 1 }) as { id: string };
  const { bot, calls } = mkBot();
  await renderAndSwapCard(bot, {} as never, r.id, "IM", 2);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["editMessageReplyMarkup"],
  );
});

// ---------- 9. лайк ----------

function likeHarness(yandex: Record<string, unknown>) {
  const handlers: { re: RegExp; fn: (ctx: unknown) => Promise<void> }[] = [];
  const bot = {
    inlineQuery: () => undefined,
    chosenInlineResult: () => undefined,
    callbackQuery: (re: RegExp, fn: (ctx: unknown) => Promise<void>) => handlers.push({ re, fn }),
  };
  const container = {
    resolveToken: async () => "tok",
    getYandexService: async () => yandex,
  } as unknown as Container;
  registerInline(bot as never, container);
  const like = handlers.find((h) => h.re.test("like:t:42"))!.fn;
  const answers: unknown[] = [];
  const ctx = () => ({ data: "like:t:42", from: { id: 1 }, answer: async (p: unknown) => answers.push(p) });
  return { like, ctx, answers };
}

test("лайк: список лайков не получен → «не вышло», setTrackLiked не зовём", async () => {
  let sets = 0;
  const { like, ctx, answers } = likeHarness({
    isTrackLiked: async () => {
      throw new Error("net");
    },
    setTrackLiked: async () => {
      sets++;
      return true;
    },
  });
  await like(ctx());
  assert.equal(sets, 0);
  assert.ok(JSON.stringify(answers[0]).includes("не вышло"));
});

test("лайк: параллельные тапы на пару (user, track) — второй не ставит повторно", async () => {
  let sets = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { like, ctx, answers } = likeHarness({
    isTrackLiked: async () => {
      await gate;
      return false;
    },
    setTrackLiked: async () => {
      sets++;
      return true;
    },
  });
  const a = like(ctx());
  const b = like(ctx());
  release();
  await Promise.all([a, b]);
  assert.equal(sets, 1);
  assert.equal(answers.length, 2);
});

// ---------- 11. «частично»: карточка ушла, трек нет ----------

test("deliverCardAndTrack: sendPhoto ок, sendAudio упал → «partial», а не «none»", async () => {
  const { bot } = mkBot(["sendAudio"]);
  const senders = chatRichSenders(bot, 10, { trackId: "42", trackLayout: "button", botUsername: "nowymbot" });
  const res = await deliverCardAndTrack({
    label: "t",
    card: async () => ({ fileId: "CARD", release: () => undefined }) as never,
    track: async () => ({ fileId: "AUD", title: "S", performer: "A", durationSec: 1, degraded: false }),
    sendRich: async () => {
      throw Object.assign(new Error("bad"), { name: "TelegramError", code: 400 });
    },
    fallback: senders.fallback,
  });
  assert.equal(res, "partial");
});

test("chatRichSenders.fallback: без карточки сбой sendAudio — обычная ошибка (partial не нужен)", async () => {
  const { bot } = mkBot(["sendAudio"]);
  const { fallback } = chatRichSenders(bot, 10, { trackId: "42", trackLayout: "button", botUsername: "nowymbot" });
  await assert.rejects(
    fallback({ cardFileId: null, audio: { fileId: "A", title: "", performer: "", durationSec: 1, degraded: false } }),
    (e: unknown) => !(e instanceof PartialDeliveryError),
  );
});

// ---------- D9/D10: общий catch onChosenResult, playlist: ----------

test("D9: исключение в onChosenResult → кнопка «загрузить снова», а не вечное «качаю...»", async () => {
  const { container } = chosenContainer({ cached: null, limiterAllows: true });
  (container as unknown as { getUserSettings: () => Promise<never> }).getUserSettings = async () => {
    throw new Error("pg down");
  };
  const { bot, calls } = mkBot();
  await onChosenResult({ from: { id: 1 }, resultId: "42", inlineMessageId: "IM", query: "song" }, container, bot);
  const last = calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1);
  assert.ok(last, "разметка должна быть заменена");
  assert.ok(JSON.stringify(last.params.reply_markup).includes("load:42"));
});

test("D10: выбор playlist: пропускается молча, как album: (без warning «невалидный result_id»)", async () => {
  const { container } = chosenContainer({ cached: null, limiterAllows: true });
  let tokenCalls = 0;
  (container as unknown as { resolveToken: () => Promise<string> }).resolveToken = async () => {
    tokenCalls++;
    return "tok";
  };
  const { bot, calls } = mkBot();
  const out: string[] = [];
  const origWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await onChosenResult({ from: { id: 1 }, resultId: "playlist:alice:3", inlineMessageId: "IM" }, container, bot);
  } finally {
    process.stdout.write = origWrite;
  }
  assert.equal(tokenCalls, 0);
  assert.equal(calls.length, 0);
  assert.ok(!out.some((l) => l.includes("невалидный result_id")), out.join(""));
  assert.equal(container.inlineOwners.get("IM"), 1, "владелец всё равно запоминается");
});

// ---------- D24: тексты запросов не пишутся на INFO ----------

function captureStdout(): { out: string[]; restore: () => void } {
  const out: string[] = [];
  const orig = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return { out, restore: () => (process.stdout.write = orig) };
}

test("D24: текст inline-запроса и result_id chosen — на DEBUG, не на INFO", async () => {
  let inlineHandler!: (ctx: unknown) => Promise<void>;
  const bot = {
    inlineQuery: (_re: RegExp, fn: (ctx: unknown) => Promise<void>) => {
      inlineHandler = fn;
    },
    chosenInlineResult: () => undefined,
    callbackQuery: () => undefined,
  };
  const container = {
    inlineLimiter: { check: () => [false, 3] as [boolean, number] },
    inlineOwners: new Map<string, number>(),
    inlineEffects: new Map<string, string>(),
  } as unknown as Container;
  registerInline(bot as never, container);
  const prev = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "INFO";
  const cap = captureStdout();
  try {
    await inlineHandler({ from: { id: 1 }, query: "секретный запрос", offset: "", answer: async () => true });
    await onChosenResult(
      { from: { id: 1 }, resultId: "album:secret-77", inlineMessageId: "IM" },
      container,
      mkBot().bot,
    );
  } finally {
    cap.restore();
    if (prev === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prev;
  }
  const all = cap.out.join("");
  assert.ok(!all.includes("секретный запрос"), all);
  assert.ok(!all.includes("secret-77"), all);
});

test("renderAndSwapCard: рендер карточки упал → «загрузить снова» перерисовывает карточку (crd:), а не вечное «готовлю карточку»", async () => {
  const container = {
    botUsername: "nowymbot",
    getUserSettings: async () => {
      throw new Error("pool down");
    },
    resolveToken: async () => "tok",
  } as never;
  const r = buildNowPlayingCardResult(container, track(557), { progress_ms: 0 }, { id: 1 }) as { id: string };
  const { bot, calls } = mkBot();
  await renderAndSwapCard(bot, container, r.id, "IM", 1);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["editMessageReplyMarkup"],
  );
  const kb = JSON.stringify(calls[0]!.params.reply_markup);
  assert.ok(kb.includes(`crd:${r.id}`), kb);
  assert.ok(kb.includes("загрузить снова"), kb);
});

// ---------- review-2 L7: повтор карточки = перерисовка карточки ----------

function crdHarness(container: unknown, bot: { api: unknown }) {
  let fn!: (ctx: unknown) => Promise<void>;
  const reg = {
    inlineQuery: () => undefined,
    chosenInlineResult: () => undefined,
    callbackQuery: (re: RegExp, h: (ctx: unknown) => Promise<void>) => {
      if (re.test("crd:npc:1:2:3")) fn = h;
    },
    api: bot.api,
  };
  registerInline(reg as never, container as never);
  const toasts: unknown[] = [];
  const tap = (data: string, from = 1) =>
    fn({
      data,
      inlineMessageId: "IM",
      from: { id: from },
      answer: async (p: unknown) => {
        toasts.push(p);
        return true;
      },
    });
  return { tap, toasts };
}

function renderingContainer() {
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
  };
}

test("crd: тап владельца перерисовывает карточку (editMessageMedia фото), а не качает аудио", async () => {
  const container = renderingContainer();
  const r = buildNowPlayingCardResult(container as never, track(558), { progress_ms: 0 }, { id: 1 }) as {
    id: string;
  };
  const calls: Call[] = [];
  const rec = (method: string, ret: unknown) => async (params: Record<string, unknown>) => {
    calls.push({ method, params });
    return ret;
  };
  const bot = {
    api: {
      sendPhoto: rec("sendPhoto", { message_id: 9, photo: [{ file_id: "CARD" }] }),
      deleteMessage: rec("deleteMessage", true),
      editMessageMedia: rec("editMessageMedia", true),
      editMessageReplyMarkup: rec("editMessageReplyMarkup", true),
    },
  };
  const h = crdHarness(container, bot as never);
  await h.tap(`crd:${r.id}`);
  const edit = calls.find((c) => c.method === "editMessageMedia");
  assert.equal((edit!.params.media as { type: string; media: string }).type, "photo");
  assert.equal((edit!.params.media as { media: string }).media, "CARD");
});

test("crd: тап не владельца в группе → тост, карточку не трогаем", async () => {
  const container = renderingContainer();
  const r = buildNowPlayingCardResult(container as never, track(559), { progress_ms: 0 }, { id: 1 }) as {
    id: string;
  };
  const { bot, calls } = mkBot();
  const h = crdHarness(container, bot as never);
  await h.tap(`crd:${r.id}`, 2);
  assert.equal(calls.length, 0);
  assert.ok(JSON.stringify(h.toasts).includes("show_alert"));
});
