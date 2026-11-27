// D20: сбой Яндекса (сеть/5xx/429) ≠ «не найдено» — для поиска и трека по id в inline/лс
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Container } from "../src/bot/container.ts";
import { onChosenResult, registerInline, sendTrackToChat } from "../src/bot/handlers/inline/index.ts";
import { SearchService } from "../src/services/search.ts";
import { YandexClient, YandexUnavailableError } from "../src/yandex/client.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function clientWith(handler: () => Response | Promise<Response>): YandexClient {
  const fetchFn = async (input: unknown): Promise<Response> => {
    const url = String((input as { url?: string }).url ?? input);
    if (url.includes("account/status")) return json({ result: { account: { uid: 1 } } });
    return handler();
  };
  return new YandexClient(
    "t",
    null,
    { fetch: fetchFn as unknown as typeof fetch, retryBaseMs: 1, retryMaxMs: 4000 },
    async () => {},
  );
}

test("strict getTrackById: 5xx → YandexUnavailableError, без strict — null как раньше", async () => {
  const c = clientWith(() => json({ error: "boom" }, 500));
  await assert.rejects(c.getTrackById(42, { strict: true }), YandexUnavailableError);
  assert.equal(await c.getTrackById(42), null);
});

test("strict getTrackById: 429 → YandexUnavailableError", async () => {
  const c = clientWith(() => json({ error: "slow" }, 429));
  await assert.rejects(c.getTrackById(42, { strict: true }), YandexUnavailableError);
});

test("strict getTrackById: сеть упала → YandexUnavailableError", async () => {
  const c = clientWith(() => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(c.getTrackById(42, { strict: true }), YandexUnavailableError);
});

test("strict getTrackById: 404 — это «не найдено», null без исключения", async () => {
  const c = clientWith(() => json({ error: "nf" }, 404));
  assert.equal(await c.getTrackById(42, { strict: true }), null);
});

test("strict searchTracksPage / searchTracks: 5xx → YandexUnavailableError; без strict — пусто", async () => {
  const c = clientWith(() => json({ error: "boom" }, 503));
  await assert.rejects(c.searchTracksPage("q", 0, { strict: true }), YandexUnavailableError);
  await assert.rejects(c.searchTracks("q", 5, { strict: true }), YandexUnavailableError);
  assert.deepEqual(await c.searchTracksPage("q"), { tracks: [], total: 0, perPage: 0 });
});

function downYandex() {
  const err = () => new YandexUnavailableError("x", new Error("503"));
  return {
    getTrackById: async (_id: unknown, o?: { strict?: boolean }) => {
      if (o?.strict) throw err();
      return null;
    },
    searchTracks: async () => {
      throw err();
    },
    searchAlbums: async () => [],
    searchTracksPage: async () => {
      throw err();
    },
  };
}

test("SearchService: сбой Яндекса пробрасывается (а не превращается в пустую выдачу)", async () => {
  const svc = new SearchService(downYandex() as never, new Map() as never, null, "bot");
  await assert.rejects(svc.searchAndCreateResults("https://music.yandex.ru/track/42"), YandexUnavailableError);
  await assert.rejects(svc.searchAndCreateResults("abc"), YandexUnavailableError);
  await assert.rejects(svc.searchTracksPaged("abc", "", 10, "button", "audio"), YandexUnavailableError);
});

function inlineHarness(trackService: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  let handler!: (ctx: unknown) => Promise<void>;
  const bot = {
    on: (ev: string, fn: (ctx: unknown) => Promise<void>) => {
      if (ev === "inline_query") handler = fn;
    },
    callbackQuery: () => undefined,
  };
  const page0 = new Map<string, unknown>();
  const container = {
    inlineLimiter: { check: () => [true, 0] as [boolean, number] },
    resolveToken: async () => "tok",
    getUserSettings: async () => ({
      track_layout: "button",
      track_send_mode: "audio",
      card_layout: "button",
      rich_messages: false,
    }),
    trackCache: { get: (k: string) => page0.get(k), set: (k: string, v: unknown) => page0.set(k, v) },
    getTrackService: async () => trackService,
    npWatcher: null,
    inlineOwners: new Map<string, number>(),
    inlineEffects: new Map<string, string>(),
    ...extra,
  } as unknown as Container;
  registerInline(bot as never, container);
  const answers: { results: unknown[]; params: Record<string, unknown> }[] = [];
  const run = (query: string, offset = "") =>
    handler({
      from: { id: 1 },
      query,
      offset,
      answer: async (results: unknown[], params: Record<string, unknown> = {}) => {
        answers.push({ results, params });
        return true;
      },
    });
  return { run, answers, page0 };
}

test("inline: Яндекс не отвечает → своя метка, cache_time ≤ 3, suggest не зовётся", async () => {
  let suggests = 0;
  const svc = new SearchService(downYandex() as never, new Map() as never, null, "bot");
  (svc.yandexService as unknown as Record<string, unknown>).suggestCorrection = async () => {
    suggests++;
    return "abcd";
  };
  const h = inlineHarness(svc as never);
  await h.run("abc");
  const a = h.answers[0]!;
  assert.equal(a.results.length, 0);
  const label = (a.params.button as { text: string }).text;
  assert.ok(label.includes("Яндекс не отвечает"), label);
  assert.ok((a.params.cache_time as number) <= 3);
  assert.equal(a.params.is_personal, true);
  assert.equal(suggests, 0);
});

test("inline: ссылка на трек при сбое Яндекса → «Яндекс не отвечает», в page0-кэш не пишется", async () => {
  const svc = new SearchService(downYandex() as never, new Map() as never, null, "bot");
  const h = inlineHarness(svc as never);
  await h.run("https://music.yandex.ru/track/42");
  const label = (h.answers[0]!.params.button as { text: string }).text;
  assert.ok(label.includes("Яндекс не отвечает"), label);
  assert.equal(h.page0.size, 0);
});

test("лс: трек по ссылке при сбое Яндекса → «Яндекс не отвечает», а не «трек не найден»", async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const rec = (method: string) => async (params: Record<string, unknown>) => {
    calls.push({ method, params });
    return { message_id: 1 };
  };
  const bot = { api: { editMessageText: rec("editMessageText"), sendMessage: rec("sendMessage") } };
  const container = {
    downloadLimiter: { check: () => [true, 0] as [boolean, number] },
    getTrackService: async () => ({ getTrackObject: () => null, cacheTrackObject: () => undefined }),
    getYandexService: async () => downYandex(),
    cacheDb: { get: async () => null },
    getUserSettings: async () => ({ track_quality: "best", track_layout: "button", rich_messages: false }),
  } as unknown as Container;
  await sendTrackToChat({
    bot: bot as never,
    chatId: 10,
    userId: 1,
    container,
    trackId: "42",
    token: "tok",
    statusMsgId: 5,
  });
  const text = JSON.stringify(calls.at(-1)?.params.text);
  assert.ok(text.includes("Яндекс не отвечает"), text);
});

// ---------- review-2 #1: сбой Яндекса не мешает отдать уже закэшированный file_id ----------

const cachedHit = {
  telegram_file_id: "CACHED_FID",
  is_cached: true,
  codec: "mp3",
  bitrate_kbps: 320,
  artist: "A",
  title: "S",
  duration: 200,
};

function outageContainer(cached: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  return {
    botUsername: "nowymbot",
    inlineOwners: new Map<string, number>(),
    inlineEffects: new Map<string, string>(),
    downloadLimiter: { check: () => [true, 0] as [boolean, number] },
    resolveToken: async () => "tok",
    getTrackService: async () => ({ getTrackObject: () => null, cacheTrackObject: () => undefined }),
    getYandexService: async () => downYandex(),
    cacheDb: { get: async () => cached },
    getUserSettings: async () => ({ track_quality: "best", track_layout: "button", rich_messages: false }),
    ...extra,
  } as unknown as Container;
}

function recBot() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const rec = (method: string) => async (params: Record<string, unknown>) => {
    calls.push({ method, params });
    return { message_id: 1 };
  };
  const bot = {
    api: {
      editMessageText: rec("editMessageText"),
      sendMessage: rec("sendMessage"),
      sendAudio: rec("sendAudio"),
      deleteMessage: rec("deleteMessage"),
      editMessageMedia: rec("editMessageMedia"),
      editMessageReplyMarkup: rec("editMessageReplyMarkup"),
    },
  };
  return { bot: bot as never, calls };
}

test("лс: сбой Яндекса, но трек в кэше → аудио из кэша, а не «Яндекс не отвечает»", async () => {
  const { bot, calls } = recBot();
  await sendTrackToChat({
    bot,
    chatId: 10,
    userId: 1,
    container: outageContainer(cachedHit),
    trackId: "42",
    token: "tok",
    statusMsgId: 5,
  });
  const audio = calls.find((c) => c.method === "sendAudio");
  assert.equal(audio?.params.audio, "CACHED_FID");
  assert.ok(!JSON.stringify(calls).includes("Яндекс не отвечает"));
});

test("chosen: сбой Яндекса + трек в кэше → кнопки готового аудио, а не «загрузить снова»", async () => {
  const { bot, calls } = recBot();
  await onChosenResult(
    { from: { id: 1 }, resultId: "42", inlineMessageId: "IM", query: "song" },
    outageContainer(cachedHit),
    bot,
  );
  const last = calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1)!;
  assert.ok(JSON.stringify(last.params.reply_markup).includes("like:t:42"), JSON.stringify(last.params));
});

test("chosen tm: сбой Яндекса + трек в кэше → editMessageMedia с кэшированным file_id", async () => {
  const { bot, calls } = recBot();
  await onChosenResult(
    { from: { id: 1 }, resultId: "tm:42", inlineMessageId: "IM", query: "song" },
    outageContainer(cachedHit),
    bot,
  );
  const edit = calls.find((c) => c.method === "editMessageMedia");
  assert.equal((edit!.params.media as { media: string }).media, "CACHED_FID");
});

test("chosen: сбой Яндекса и кэш пуст → кнопка «Яндекс не отвечает» (тап = повтор load:)", async () => {
  const { bot, calls } = recBot();
  await onChosenResult(
    { from: { id: 1 }, resultId: "42", inlineMessageId: "IM", query: "song" },
    outageContainer(null),
    bot,
  );
  const last = JSON.stringify(calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1)!.params);
  assert.ok(last.includes("Яндекс не отвечает"), last);
  assert.ok(last.includes("load:42"), last);
});

function loadHandler(container: Container, bot: unknown) {
  let fn!: (ctx: unknown) => Promise<void>;
  const reg = {
    on: () => undefined,
    callbackQuery: (re: RegExp, h: (ctx: unknown) => Promise<void>) => {
      if (re.test("load:1")) fn = h;
    },
    api: (bot as { api: unknown }).api,
  };
  registerInline(reg as never, container);
  container.inlineOwners.set("IM", 1);
  return (data: string) => fn({ data, inline_message_id: "IM", from: { id: 1 }, answer: async () => true } as unknown);
}

test("load: сбой Яндекса + трек в кэше → аудио из кэша", async () => {
  const { bot, calls } = recBot();
  await loadHandler(outageContainer(cachedHit), bot)("load:42");
  const edit = calls.find((c) => c.method === "editMessageMedia");
  assert.equal((edit!.params.media as { media: string }).media, "CACHED_FID");
});

test("load: сбой Яндекса и кэш пуст → кнопка «Яндекс не отвечает»", async () => {
  const { bot, calls } = recBot();
  await loadHandler(outageContainer(null), bot)("load:42");
  const last = JSON.stringify(calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1)!.params);
  assert.ok(last.includes("Яндекс не отвечает"), last);
});

test("лс: сбой Яндекса и кэш пуст → «Яндекс не отвечает» без «❌»", async () => {
  const { bot, calls } = recBot();
  await sendTrackToChat({
    bot,
    chatId: 10,
    userId: 1,
    container: outageContainer(null),
    trackId: "42",
    token: "tok",
    statusMsgId: 5,
  });
  const text = JSON.stringify(calls.at(-1)?.params.text);
  assert.ok(text.includes("Яндекс не отвечает") && !text.includes("❌"), text);
});

test("inline: сбой Яндекса на странице прокрутки → next_offset = текущий offset (листание не обрывается)", async () => {
  const svc = new SearchService(downYandex() as never, new Map() as never, null, "bot");
  const h = inlineHarness(svc as never);
  await h.run("abc", "20");
  const a = h.answers[0]!;
  assert.equal(a.results.length, 0);
  assert.equal(a.params.next_offset, "20");
  assert.ok((a.params.cache_time as number) <= 3);
});

/** первичный поиск пуст, а поиск по исправленному/фолбэк-фразе падает сбоем Яндекса. */
function emptyThenDown(badQuery: string) {
  const err = () => new YandexUnavailableError("x", new Error("503"));
  return {
    yandexService: { suggestCorrection: async () => "abcd" },
    cacheTrackObject: () => undefined,
    searchTracksPaged: async (q: string) => {
      if (q === badQuery) throw err();
      return { results: [], nextOffset: "" };
    },
    searchAndCreateResults: async (q: string) => {
      if (q === badQuery) throw err();
      return [];
    },
  };
}

test("inline: сбой Яндекса в поиске по suggest-исправлению → «Яндекс не отвечает», а не «не найдено»", async () => {
  const h = inlineHarness(emptyThenDown("abcd"));
  await h.run("abc");
  const label = (h.answers[0]!.params.button as { text: string }).text;
  assert.ok(label.includes("Яндекс не отвечает"), label);
});

test("inline: сбой Яндекса в лирик-фолбэке на фразу → «Яндекс не отвечает», а не «не найдено»", async () => {
  const genius = { searchSong: async () => ({ artist: "Artist", title: "Title" }) };
  const h = inlineHarness(emptyThenDown("строчка песни"), { genius });
  await h.run('"строчка песни');
  const label = (h.answers[0]!.params.button as { text: string }).text;
  assert.ok(label.includes("Яндекс не отвечает"), label);
});
