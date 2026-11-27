/** PollingWatchdog: обрыв висящего getUpdates и выход при повторном зависании. */
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, mock, test } from "node:test";
import { run } from "@yaebal/runner";
import { Bot, TelegramError } from "yaebal";
import {
  confirmPolledOffset,
  PollingStalledError,
  PollingWatchdog,
  watchedRunnerBot,
} from "../src/bot/pollingWatchdog.ts";

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

  // цикл раннера шлёт новый getUpdates — он завершается
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

test("L1: раннер проснулся в окне восстановления — новый getUpdates лечит без выхода", async () => {
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

test("L1: известный retry_after из 429 сдвигает порог — пауза раннера не считается зависанием", async () => {
  const { wd, fatal } = mk();
  wd.start();
  const err429 = new TelegramError("getUpdates", 429, "Too Many Requests: retry after 200", { retry_after: 200 });
  await assert.rejects(
    wd.hook(null, () => Promise.reject(err429)),
    /Too Many Requests/,
  );
  // раннер спит 200s; порог 90s — без учёта retry_after было бы окно idle и затем выход
  advance(200_000 + STALL);
  assert.deepEqual(fatal, []);
  // ошибка, возвращённая значением (не брошенная), — тоже учитывается
  await wd.hook(null, () => Promise.resolve({ parameters: { retry_after: 300 } }));
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

  // новый запрос тоже висит; старый вдруг отвечает (abort / 409)
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

test("с настоящим yaebal Bot + @yaebal/runner: висящий getUpdates обрывается (fetch абортится), раннер шлёт новый", async () => {
  mock.timers.reset(); // здесь реальные таймеры: крутится настоящий цикл раннера
  let getUpdatesCalls = 0;
  let firstAborted = false;
  let resolveSecond!: () => void;
  const secondDone = new Promise<void>((r) => {
    resolveSecond = r;
  });
  const json = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split("/").at(-1);
    if (method === "getMe") return json({ id: 1, is_bot: true, first_name: "t", username: "t_bot" });
    if (method === "getUpdates") {
      getUpdatesCalls++;
      if (getUpdatesCalls === 1) {
        // висит, пока сторож не абортит сам fetch
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            firstAborted = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      }
      if (getUpdatesCalls === 2) {
        resolveSecond();
        return json([]);
      }
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    }
    return json(true);
  }) as typeof fetch;
  const fatal: string[] = [];
  const pollErrors: unknown[] = [];
  const bot = new Bot("1:x", { fetch: fakeFetch });
  // окно восстановления (= stallMs) должно перекрыть backoff раннера после ошибки (3с)
  const wd = new PollingWatchdog({ stallMs: 3500, checkEveryMs: 50, onFatal: (r) => void fatal.push(r) });
  const handle = run(watchedRunnerBot(bot, wd), { onError: (e) => void pollErrors.push(e) });
  wd.start();
  try {
    await secondDone; // обрыв через ~3.5с + backoff раннера 3с
    assert.ok(getUpdatesCalls >= 2);
    assert.ok(firstAborted, "висящий fetch абортится, а не остаётся висеть");
    assert.ok(pollErrors.some((e) => e instanceof PollingStalledError));
    assert.deepEqual(fatal, []);
  } finally {
    wd.stop();
    await handle.stop();
  }
});

test("на потолке раннера (апдейты в работе ≥ concurrency) нет getUpdates — не зависание, без выхода", async () => {
  const fatal: string[] = [];
  const wd = new PollingWatchdog({
    stallMs: STALL,
    checkEveryMs: CHECK,
    concurrency: 2,
    onFatal: (r) => void fatal.push(r),
  });
  const gate = deferred();
  const bot = {
    api: { getUpdates: async () => [] },
    handleUpdate: () => gate.promise.then(() => undefined),
  };
  const wrapped = watchedRunnerBot(bot, wd);
  wd.start();
  const a = wrapped.handleUpdate({ update_id: 1 } as never);
  const b = wrapped.handleUpdate({ update_id: 2 } as never);
  advance(STALL * 5); // без счётчика тут было бы окно idle и onFatal
  assert.deepEqual(fatal, []);

  // слот освободился — обычная логика: полное окно stallMs, затем окно восстановления, затем выход
  gate.resolve(undefined);
  await Promise.all([a, b]);
  advance(STALL);
  assert.deepEqual(fatal, []);
  advance(CHECK + STALL + CHECK);
  assert.equal(fatal.length, 1);
  wd.stop();
});

test("ниже потолка отсутствие getUpdates по-прежнему ведёт к выходу", async () => {
  const fatal: string[] = [];
  const wd = new PollingWatchdog({
    stallMs: STALL,
    checkEveryMs: CHECK,
    concurrency: 2,
    onFatal: (r) => void fatal.push(r),
  });
  const bot = { api: { getUpdates: async () => [] }, handleUpdate: () => new Promise<void>(() => {}) };
  void watchedRunnerBot(bot, wd).handleUpdate({ update_id: 1 } as never);
  wd.start();
  advance(STALL * 3);
  assert.equal(fatal.length, 1);
});

test("shutdown: confirmPolledOffset подтверждает max update_id полученных пачек, не дожидаясь дренажа", async () => {
  mock.timers.reset(); // настоящий цикл раннера
  const polls: Record<string, unknown>[] = [];
  let batch = true;
  let release!: () => void;
  const stuck = new Promise<void>((r) => {
    release = r;
  });
  const api = {
    getUpdates: async (params?: Record<string, unknown>, opts?: { signal?: AbortSignal }) => {
      polls.push(params ?? {});
      if (params?.timeout === 0) return [] as never; // подтверждение
      if (batch) {
        batch = false;
        return [{ update_id: 41 }, { update_id: 43 }, { update_id: 42 }] as never;
      }
      // long-poll: висит до abort
      return new Promise<never>((_, reject) =>
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    },
  };
  const stops: Promise<void>[] = [];
  for (const wd of [null, new PollingWatchdog({ stallMs: STALL, onFatal: () => {} })]) {
    batch = true;
    polls.length = 0;
    const polled = watchedRunnerBot({ api, handleUpdate: () => stuck }, wd);
    assert.equal(polled.maxUpdateId(), -1);
    const handle = run(polled, { sequentializeBy: () => undefined, timeout: 30, onError: () => {} });
    while (polls.length < 2) await flush(); // пачка получена, висит следующий long-poll
    assert.equal(polled.maxUpdateId(), 43);

    stops.push(handle.stop()); // апдейты всё ещё в работе — дренаж не закончится сам
    await confirmPolledOffset(api, polled.maxUpdateId());
    assert.deepEqual(polls.at(-1), { offset: 44, limit: 1, timeout: 0 });
  }
  release();
  await Promise.all(stops);
});

test("confirmPolledOffset: ничего не получали — запроса нет", async () => {
  let calls = 0;
  const getUpdates = async () => {
    calls++;
    return [];
  };
  await confirmPolledOffset({ getUpdates }, -1);
  assert.equal(calls, 0);
});

test("getUpdates падает 5 раз подряд → один алерт на серию; успех сбрасывает счётчик", async () => {
  const outcomes: (Error | [])[] = [];
  const api = {
    getUpdates: async () => {
      const o = outcomes.shift() ?? [];
      if (o instanceof Error) throw o;
      return o as never;
    },
  };
  for (const wd of [null, new PollingWatchdog({ stallMs: STALL, onFatal: () => {} })]) {
    const alerts: number[] = [];
    const polled = watchedRunnerBot({ api, handleUpdate: async () => {} }, wd, {
      failAlertAfter: 5,
      onPollFailing: (n) => void alerts.push(n),
    });
    const poll = () => polled.api.getUpdates({}).catch(() => "failed");
    const err = new Error("400: Bad Request: allowed_updates");
    outcomes.push(err, err, err, err);
    for (let i = 0; i < 4; i++) await poll();
    outcomes.push([]); // успех посреди серии — счётчик с нуля
    await poll();
    for (let i = 0; i < 4; i++) outcomes.push(err);
    for (let i = 0; i < 4; i++) await poll();
    assert.deepEqual(alerts, [], "4 подряд — ещё не алерт");
    for (let i = 0; i < 7; i++) outcomes.push(err);
    for (let i = 0; i < 7; i++) await poll();
    assert.deepEqual(alerts, [5], "алерт ровно один раз на серию");
    outcomes.push([]);
    await poll();
    for (let i = 0; i < 5; i++) outcomes.push(err);
    for (let i = 0; i < 5; i++) await poll();
    assert.deepEqual(alerts, [5, 5], "новая серия после восстановления — новый алерт");
  }
});
