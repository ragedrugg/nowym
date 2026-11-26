import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { YnisonDeviceDisplacedError, YnisonUnauthorizedError } from "@dvxch/yandex-music";
import { NowPlayingWatcher, type RealtimeLike } from "../src/services/nowPlayingWatcher.ts";
import type { UsersDb } from "../src/storage/users.ts";

// Без сети и БД: usersDb возвращает null-токен (старый код без инъекции уснёт на
// NO_TOKEN_RETRY_MS и провалит тест по таймауту, а не полезет в сеть), всё
// остальное подменяется через deps.
const fakeUsersDb = { getToken: async () => null } as unknown as UsersDb;

interface FakeRtScript {
  terminal?: Error | null;
  /** событие open перед выходом (имитирует успешное подключение). */
  open?: boolean;
  /** start() не резолвится до stop(). */
  hang?: boolean;
  /** сколько «проработала» сессия по тестовым часам. */
  uptimeMs?: number;
}

const clock = { t: 0 };

class FakeRt extends EventEmitter {
  terminalError: Error | null = null;
  nowPlaying = null;
  lastStateAgeMs = null;
  private release: (() => void) | null = null;
  constructor(private readonly script: FakeRtScript) {
    super();
  }
  async start(): Promise<void> {
    if (this.script.open) this.emit("open");
    if (this.script.hang) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    clock.t += this.script.uptimeMs ?? 0;
    this.terminalError = this.script.terminal ?? null;
    this.emit("close", this.terminalError);
  }
  stop(): void {
    this.release?.();
  }
}

interface Harness {
  watcher: NowPlayingWatcher;
  sleeps: number[];
  tokenReads: number;
  refreshes: number;
  created: number;
  done: Promise<void>;
}

/** Гоняет watcher, пока не наберётся `iterations` пауз, потом stop(). */
function harness(opts: {
  iterations: number;
  rt: (i: number) => FakeRtScript;
  token?: (i: number) => string | null;
}): Harness {
  clock.t = 0;
  const h = {
    sleeps: [] as number[],
    tokenReads: 0,
    refreshes: 0,
    created: 0,
  } as Harness;
  let finish!: () => void;
  h.done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const watcher = new NowPlayingWatcher(fakeUsersDb, 1, {
    readToken: async () => {
      const i = h.tokenReads++;
      return opts.token ? opts.token(i) : "tok";
    },
    createRealtime: () => new FakeRt(opts.rt(h.created++)) as unknown as RealtimeLike,
    sleep: async (ms) => {
      h.sleeps.push(ms);
      if (h.sleeps.length >= opts.iterations) {
        void watcher.stop();
        finish();
      }
    },
    refreshToken: async () => {
      h.refreshes++;
      return null;
    },
    now: () => clock.t,
  });
  h.watcher = watcher;
  return h;
}

async function run(h: Harness): Promise<void> {
  h.watcher.start();
  await h.done;
  await h.watcher.stop();
}

const unauthorized = () => new YnisonUnauthorizedError("401");

test("unauthorized: растущий backoff >= 60s, одно чтение токена и один refresh на проход", {
  timeout: 2000,
}, async () => {
  const h = harness({ iterations: 5, rt: () => ({ terminal: unauthorized() }) });
  await run(h);
  assert.deepEqual(h.sleeps, [60_000, 120_000, 240_000, 480_000, 600_000]);
  assert.equal(h.created, 5);
  assert.equal(h.tokenReads, 5);
  assert.equal(h.refreshes, 4); // 5-я пауза прервана stop() до refresh
});

test("displaced: пауза >= 30s на каждом проходе", { timeout: 2000 }, async () => {
  const h = harness({ iterations: 3, rt: () => ({ terminal: new YnisonDeviceDisplacedError("kicked") }) });
  await run(h);
  assert.equal(h.sleeps.length, 3);
  for (const ms of h.sleeps) assert.ok(ms >= 30_000, `ms=${ms}`);
  assert.equal(h.refreshes, 0);
});

test("тихий выход без terminalError: пауза >= 1s и растёт, не горячий цикл", { timeout: 2000 }, async () => {
  const h = harness({ iterations: 4, rt: () => ({}) });
  await run(h);
  assert.deepEqual(h.sleeps, [1000, 2000, 4000, 8000]);
});

test("смена токена сбрасывает backoff", { timeout: 2000 }, async () => {
  // проходы: tok, tok, tok2 (после смены backoff снова с начала)
  const h = harness({
    iterations: 3,
    rt: () => ({ terminal: unauthorized() }),
    token: (i) => (i < 2 ? "tok" : "tok2"),
  });
  await run(h);
  assert.deepEqual(h.sleeps, [60_000, 120_000, 60_000]);
});

test("долгая сессия сбрасывает backoff", { timeout: 2000 }, async () => {
  // проход 1 «прожил» 5 минут (часы тестового clock двигает сам FakeRt)
  const h = harness({
    iterations: 3,
    rt: (i) => ({ terminal: unauthorized(), uptimeMs: i === 1 ? 300_000 : 0 }),
  });
  await run(h);
  assert.deepEqual(h.sleeps, [60_000, 60_000, 120_000]);
});

test("connected сбрасывается на close и после терминального выхода", { timeout: 2000 }, async () => {
  const h = harness({ iterations: 1, rt: () => ({ open: true, terminal: unauthorized() }) });
  await run(h);
  assert.equal(h.watcher.health().connected, false);
});

test("connected=true пока сессия жива, false после close", { timeout: 2000 }, async () => {
  let rt!: FakeRt;
  const w = new NowPlayingWatcher(fakeUsersDb, 1, {
    readToken: async () => "tok",
    createRealtime: () => {
      rt = new FakeRt({ hang: true, open: true });
      return rt as unknown as RealtimeLike;
    },
    sleep: () => new Promise<void>(() => {}),
  });
  w.start();
  while (!w.health().connected) await new Promise((r) => setImmediate(r));
  rt.emit("close", null);
  assert.equal(w.health().connected, false);
  await w.stop();
});

test("stop() обрывает ожидающий sleep", { timeout: 2000 }, async () => {
  let sleeping!: () => void;
  const inSleep = new Promise<void>((resolve) => {
    sleeping = resolve;
  });
  const w = new NowPlayingWatcher(fakeUsersDb, 1, {
    readToken: async () => "tok",
    createRealtime: () => new FakeRt({ terminal: unauthorized() }) as unknown as RealtimeLike,
    // «вечный» sleep: только stop() может его прервать
    sleep: () => {
      sleeping();
      return new Promise<void>(() => {});
    },
  });
  w.start();
  await inSleep;
  const t0 = Date.now();
  await w.stop();
  assert.ok(Date.now() - t0 < 500);
  assert.equal(w.health().running, false);
});

test("resolveTrack: упавший tracks() не кэшируется, повтор делает новый lookup", { timeout: 2000 }, async () => {
  const w = new NowPlayingWatcher(fakeUsersDb, 1);
  let calls = 0;
  const track = { id: 7 };
  (w as unknown as { lib: unknown }).lib = {
    tracks: async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return [track];
    },
  };
  const resolve = (w as unknown as { resolveTrack: (id: string) => Promise<unknown> }).resolveTrack.bind(w);
  assert.equal(await resolve("7"), null);
  assert.equal(await resolve("7"), track);
  assert.equal(await resolve("7"), track);
  assert.equal(calls, 2);
});
