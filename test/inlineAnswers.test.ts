// пустые/ошибочные inline-ответы: короткий cache_time + is_personal, ошибки не пишутся в page0-кэш
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Container } from "../src/bot/container.ts";
import { registerInline } from "../src/bot/handlers/inline/index.ts";

type Answer = { results: unknown[]; params: Record<string, unknown> };

function harness(opts: {
  allowed?: boolean;
  token?: string | null;
  trackService?: Record<string, unknown> | (() => never);
}) {
  let inlineHandler!: (ctx: unknown) => Promise<void>;
  const bot = {
    inlineQuery: (_re: RegExp, fn: (ctx: unknown) => Promise<void>) => {
      inlineHandler = fn;
    },
    chosenInlineResult: () => undefined,
    callbackQuery: () => undefined,
  };
  const page0 = new Map<string, unknown>();
  const container = {
    inlineLimiter: { check: () => [opts.allowed ?? true, 3] as [boolean, number] },
    resolveToken: async () => (opts.token === undefined ? "tok" : opts.token),
    getUserSettings: async () => ({
      track_layout: "button",
      track_send_mode: "audio",
      card_layout: "button",
      rich_messages: false,
    }),
    trackCache: { get: (k: string) => page0.get(k), set: (k: string, v: unknown) => page0.set(k, v) },
    getTrackService: async () => {
      if (typeof opts.trackService === "function") opts.trackService();
      return opts.trackService;
    },
    npWatcher: null,
    inlineOwners: new Map<string, number>(),
    inlineEffects: new Map<string, string>(),
  } as unknown as Container;
  registerInline(bot as never, container);
  const answers: Answer[] = [];
  let failNonEmpty = false;
  const failOnResults = () => {
    failNonEmpty = true;
  };
  const run = (query: string, offset = "") =>
    inlineHandler({
      from: { id: 1 },
      query,
      offset,
      answer: async (results: unknown[], params: Record<string, unknown> = {}) => {
        answers.push({ results, params });
        if (failNonEmpty && results.length > 0) throw new Error("answer boom");
        return true;
      },
    });
  return { run, answers, page0, failOnResults };
}

function assertShortPersonal(a: Answer | undefined) {
  assert.ok(a);
  assert.equal(a.params.is_personal, true, JSON.stringify(a.params));
  assert.ok(typeof a.params.cache_time === "number" && a.params.cache_time <= 3, JSON.stringify(a.params));
}

test("inline: лимитер сработал → ответ personal и cache_time ≤ 3", async () => {
  const h = harness({ allowed: false });
  await h.run("abc");
  assertShortPersonal(h.answers[0]);
});

test("inline: нет токена → «войти» personal и cache_time ≤ 3", async () => {
  const h = harness({ token: null });
  await h.run("");
  assertShortPersonal(h.answers[0]);
});

test("inline: клиент не создан → personal и cache_time ≤ 3", async () => {
  const h = harness({
    trackService: () => {
      throw new Error("boom");
    },
  });
  await h.run("abc");
  assertShortPersonal(h.answers[0]);
});

test("inline: «не найдено» по тексту → personal, cache_time ≤ 3", async () => {
  const h = harness({
    trackService: {
      searchTracksPaged: async () => ({ results: [], nextOffset: "" }),
      yandexService: { suggestCorrection: async () => null },
    },
  });
  await h.run("abc");
  assertShortPersonal(h.answers[0]);
});

test("inline: «не найдено» по ссылке → personal, cache_time ≤ 3, в page0-кэш не пишется", async () => {
  const h = harness({
    trackService: {
      searchAndCreateResults: async () => [],
      yandexService: { suggestCorrection: async () => null },
    },
  });
  await h.run("https://music.yandex.ru/track/1");
  assertShortPersonal(h.answers[0]);
  assert.equal(h.page0.size, 0);
});

test("inline: пустая страница при скролле → personal, cache_time ≤ 3, next_offset сохраняется", async () => {
  const h = harness({
    trackService: { searchTracksPaged: async () => ({ results: [], nextOffset: "20" }) },
  });
  await h.run("abc", "10");
  assertShortPersonal(h.answers[0]);
  assert.equal(h.answers[0]!.params.next_offset, "20");
});

test("inline: исключение в обработке → «ошибка» personal, cache_time ≤ 3", async () => {
  const h = harness({
    trackService: {
      searchTracksPaged: async () => ({ results: [{ id: "x" }], nextOffset: "" }),
      yandexService: { suggestCorrection: async () => null },
    },
  });
  h.failOnResults();
  await h.run("abc");
  const last = h.answers.at(-1);
  assert.equal(last?.results.length, 0);
  assertShortPersonal(last);
});

test("inline: пустой запрос, ничего не играет → personal, cache_time ≤ 3", async () => {
  const h = harness({
    trackService: {
      yandexService: { getCurrentTrack: async () => null },
      recentResultsPaged: async () => ({ results: [], nextOffset: "" }),
    },
  });
  await h.run("");
  assertShortPersonal(h.answers[0]);
});

test("inline: пустой запрос, Ynison упал → «недавнее» всё равно показывается", async () => {
  const h = harness({
    trackService: {
      yandexService: {
        getCurrentTrack: async () => {
          throw new Error("ynison down");
        },
      },
      recentResultsPaged: async () => ({ results: [{ id: "tm:7" }], nextOffset: "20" }),
    },
  });
  await h.run("");
  assert.deepEqual(h.answers[0]?.results, [{ id: "tm:7" }]);
  assert.equal(h.answers[0]?.params.next_offset, "20");
  assert.equal(h.answers[0]?.params.is_personal, true);
});
