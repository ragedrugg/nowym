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

/** промотать время шагами по CHECK, чтобы каждый тик setInterval видел своё Date.now(). */
function advance(ms: number): void {
  for (let left = ms; left > 0; left -= CHECK) mock.timers.tick(Math.min(CHECK, left));
}

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

test("L1: без активного getUpdates (рвать нечего) сначала окно на восстановление, потом onFatal", () => {
  const { wd, fatal } = mk();
  wd.start();
  mock.timers.tick(STALL + CHECK);
  assert.deepEqual(fatal, [], "первое срабатывание — только окно восстановления");
  mock.timers.tick(STALL);
  assert.deepEqual(fatal, []);
  mock.timers.tick(CHECK);
  assert.equal(fatal.length, 1);
  assert.match(fatal[0]!, /нет активного запроса/);
});

test("L1: gramio проснулся в окне восстановления — новый getUpdates лечит без выхода", async () => {
  const { wd, fatal } = mk();
  wd.start();
  mock.timers.tick(STALL + CHECK); // окно «idle»
  await wd.hook(null, () => Promise.resolve([]));
  advance(STALL * 3);
  // снова окно idle и затем fatal — но только после полного цикла, не сразу
  assert.equal(fatal.length, 1);
  assert.match(fatal[0]!, /нет активного запроса/);
});

test("L1: окно idle, а затем повисший запрос — он обрывается, а не сразу выход", async () => {
  const { wd, fatal } = mk();
  wd.start();
  mock.timers.tick(STALL + CHECK); // окно «idle»
  const r = assert.rejects(
    wd.hook(null, () => new Promise(() => {})),
    PollingStalledError,
  );
  mock.timers.tick(STALL + CHECK);
  await r;
  assert.deepEqual(fatal, []);
});

test("L1: известный retry_after из 429 сдвигает порог — сон gramio не считается зависанием", async () => {
  const { wd, fatal } = mk();
  wd.start();
  const err429 = Object.assign(new Error("Too Many Requests: retry after 200"), {
    code: 429,
    payload: { retry_after: 200 },
  });
  await assert.rejects(
    wd.hook(null, () => Promise.reject(err429)),
    /Too Many Requests/,
  );
  // gramio спит 200s; порог 90s — без учёта retry_after было бы окно idle и затем выход
  advance(200_000 + STALL);
  assert.deepEqual(fatal, []);
  // suppress-вариант: TelegramError возвращается значением — тоже учитывается
  await wd.hook(null, () => Promise.resolve({ payload: { retry_after: 300 } }));
  advance(300_000 + STALL);
  assert.deepEqual(fatal, []);
  // после этого — обычная логика: окно, затем выход
  advance(CHECK + STALL + CHECK);
  assert.equal(fatal.length, 1);
});

test("L2: поздний ответ оборванного getUpdates не засчитывается как heartbeat", async () => {
  const { wd, fatal } = mk();
  wd.start();
  const hung = deferred();
  const first = assert.rejects(
    wd.hook(null, () => hung.promise),
    PollingStalledError,
  );
  mock.timers.tick(STALL + CHECK);
  await first;

  // новый запрос тоже висит; старый вдруг отвечает (свой abort gramio / 409)
  void wd.hook(null, () => new Promise(() => {})).catch(() => {});
  mock.timers.tick(STALL / 2);
  hung.reject(new Error("getUpdates request timed out"));
  await flush();

  // окно не продлено: выход ровно по исходному окну после обрыва
  mock.timers.tick(STALL / 2 + CHECK);
  assert.equal(fatal.length, 1);
  assert.match(fatal[0]!, /после обрыва/);
});

test("L2: поздний ответ оборванного запроса до старта нового тоже игнорируется", async () => {
  const { wd, fatal } = mk();
  wd.start();
  const hung = deferred();
  const first = assert.rejects(
    wd.hook(null, () => hung.promise),
    PollingStalledError,
  );
  mock.timers.tick(STALL + CHECK);
  await first;
  hung.resolve([]); // нового getUpdates ещё нет
  await flush();
  mock.timers.tick(STALL + CHECK);
  assert.equal(fatal.length, 1);
  assert.match(fatal[0]!, /после обрыва/);
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
