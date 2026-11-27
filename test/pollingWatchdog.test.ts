/** PollingWatchdog: обрыв висящего getUpdates и выход при повторном зависании. */
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, mock, test } from "node:test";
import { PollingStalledError, PollingWatchdog } from "../src/bot/pollingWatchdog.ts";

const STALL = 90_000;
const CHECK = 10_000;

beforeEach(() => mock.timers.enable({ apis: ["setInterval", "Date"] }));
afterEach(() => mock.timers.reset());

function mk() {
  const fatal: string[] = [];
  const wd = new PollingWatchdog({ stallMs: STALL, checkEveryMs: CHECK, onFatal: (r) => void fatal.push(r) });
  return { wd, fatal };
}

/** запрос, которым управляет тест. */
function deferred() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

test("завершающиеся getUpdates (и успешные, и с ошибкой) держат сторожа спокойным", async () => {
  const { wd, fatal } = mk();
  wd.start();
  for (let i = 0; i < 10; i++) {
    mock.timers.tick(30_000);
    const ok = i % 2 === 0;
    const r = wd.hook(null, () => (ok ? Promise.resolve([]) : Promise.reject(new Error("fetch failed"))));
    await (ok ? r : assert.rejects(r, /fetch failed/));
  }
  mock.timers.tick(STALL); // ровно порог — ещё не зависание
  assert.deepEqual(fatal, []);
  wd.stop();
});

test("висящий getUpdates обрывается PollingStalledError, новый запрос восстанавливает polling", async () => {
  const { wd, fatal } = mk();
  wd.start();
  const hung = deferred();
  const first = wd.hook(null, () => hung.promise);
  const firstRejected = assert.rejects(first, (e: Error) => e instanceof PollingStalledError);

  mock.timers.tick(STALL + CHECK);
  await firstRejected;
  assert.deepEqual(fatal, []);

  // цикл gramio шлёт новый getUpdates — он завершается
  await wd.hook(null, () => Promise.resolve([]));
  // поздний ответ оборванного запроса ничего не ломает
  hung.resolve([]);
  await flush();

  // после восстановления следующее зависание снова лечится обрывом, а не выходом
  const again = assert.rejects(
    wd.hook(null, () => new Promise(() => {})),
    PollingStalledError,
  );
  mock.timers.tick(STALL + CHECK);
  await again;
  assert.deepEqual(fatal, []);
  wd.stop();
});

test("после обрыва снова ни одного завершения → onFatal", async () => {
  const { wd, fatal } = mk();
  wd.start();
  const first = wd.hook(null, () => new Promise(() => {}));
  const firstRejected = assert.rejects(first, PollingStalledError);
  mock.timers.tick(STALL + CHECK);
  await firstRejected;

  // повторный запрос тоже повис
  void wd.hook(null, () => new Promise(() => {})).catch(() => {});
  mock.timers.tick(STALL);
  assert.deepEqual(fatal, []);
  mock.timers.tick(CHECK);
  assert.equal(fatal.length, 1);
  assert.match(fatal[0]!, /после обрыва/);

  mock.timers.tick(STALL * 3); // таймер остановлен — повторных вызовов нет
  assert.equal(fatal.length, 1);
});

test("зависание без активного getUpdates (рвать нечего) → сразу onFatal", () => {
  const { wd, fatal } = mk();
  wd.start();
  mock.timers.tick(STALL + CHECK);
  assert.equal(fatal.length, 1);
  assert.match(fatal[0]!, /нет активного запроса/);
});

test("stop() снимает таймер", () => {
  const { wd, fatal } = mk();
  wd.start();
  wd.stop();
  mock.timers.tick(STALL * 5);
  assert.deepEqual(fatal, []);
});

test("с настоящим gramio Bot: висящий getUpdates обрывается, цикл polling шлёт новый запрос", async () => {
  mock.timers.reset(); // здесь реальные таймеры: крутится настоящий цикл gramio
  const { Bot } = await import("gramio");
  const realFetch = globalThis.fetch;
  const realConsoleError = console.error;
  let getUpdatesCalls = 0;
  let resolveSecond!: () => void;
  const secondDone = new Promise<void>((r) => {
    resolveSecond = r;
  });
  const json = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
  globalThis.fetch = (async (url: string | URL) => {
    const method = String(url).split("/").at(-1);
    if (method === "getMe") return json({ id: 1, is_bot: true, first_name: "t", username: "t_bot" });
    if (method === "getUpdates") {
      getUpdatesCalls++;
      if (getUpdatesCalls === 1) return new Promise(() => {}); // висит навсегда
      resolveSecond();
      return json([]);
    }
    return json(true);
  }) as typeof fetch;
  console.error = () => {}; // gramio логирует оборванный запрос через console.error
  const fatal: string[] = [];
  const bot = new Bot("1:x", { api: { retryGetUpdatesWait: 0 } });
  const wd = new PollingWatchdog({ stallMs: 50, checkEveryMs: 10, onFatal: (r) => void fatal.push(r) });
  bot.onApiCall("getUpdates", wd.hook);
  try {
    await bot.start();
    wd.start();
    await secondDone;
    assert.ok(getUpdatesCalls >= 2);
    assert.deepEqual(fatal, []);
  } finally {
    wd.stop();
    await bot.stop(0);
    globalThis.fetch = realFetch;
    console.error = realConsoleError;
  }
});
