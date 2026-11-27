import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { bearerMatches, closeServer, createHttpApp, type HttpDeps, type WatcherLike } from "../src/infra/httpServer.ts";
import { secretMatches } from "../src/infra/secret.ts";

const cache = { size: 1, stats: () => ({ size: 1, hits: 2, misses: 3 }) };
const pool = (up: boolean) => ({ ping: async () => up, stats: () => ({ total: 1, idle: 1, waiting: 0 }) });

class FakeWatcher extends EventEmitter {
  current: object | null = null;
  getCurrentSnapshot() {
    return null;
  }
  getRecent() {
    return [];
  }
  health() {
    return { running: true, connected: true, lastStateAgeMs: 5, hasTrack: false };
  }
}

let tgCalls = 0;
function baseDeps(over: Partial<HttpDeps> = {}): HttpDeps {
  return {
    localApi: false,
    webhookPath: "/hook",
    webhookSecret: "s3cret-s3cret-s3cret",
    tgHandler: (_req: IncomingMessage, res: ServerResponse) => {
      tgCalls++;
      res.writeHead(200).end("tg");
    },
    nowPlayingToken: "np-token",
    metricsToken: "",
    watcher: new FakeWatcher() as unknown as WatcherLike,
    usersPool: pool(true),
    cachePool: pool(true),
    caches: { track: cache, avatar: cache, settings: cache, inline_owners: cache },
    ...over,
  };
}

let server: Server | null = null;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server?.close(() => r()));
    server = null;
  }
});

async function start(deps: HttpDeps) {
  const app = createHttpApp(deps);
  server = createServer(app.handler);
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const get = async (path: string, headers: Record<string, string> = {}, method = "GET") => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers });
    return { status: res.status, text: await res.text() };
  };
  return { app, port, get, server };
}

describe("secretMatches", () => {
  it("пустой expected → false (раньше true)", () => {
    assert.equal(secretMatches(undefined, ""), false);
    assert.equal(secretMatches("x", ""), false);
    assert.equal(secretMatches("", ""), false);
  });
  it("совпадение / несовпадение", () => {
    assert.equal(secretMatches("abc", "abc"), true);
    assert.equal(secretMatches("abd", "abc"), false);
    assert.equal(secretMatches("abcd", "abc"), false);
    assert.equal(secretMatches(undefined, "abc"), false);
    assert.equal(bearerMatches("Bearer t", "t"), true);
    assert.equal(bearerMatches("t", "t"), false);
    assert.equal(bearerMatches("Bearer ", ""), false);
  });
});

describe("webhook", () => {
  it("неверный/отсутствующий секрет → 401, tgHandler не вызван", async () => {
    tgCalls = 0;
    const { get } = await start(baseDeps());
    assert.equal((await get("/hook", {}, "POST")).status, 401);
    assert.equal((await get("/hook", { "x-telegram-bot-api-secret-token": "bad" }, "POST")).status, 401);
    assert.equal(tgCalls, 0);
  });
  it("верный секрет → tgHandler", async () => {
    tgCalls = 0;
    const { get } = await start(baseDeps());
    const r = await get("/hook", { "x-telegram-bot-api-secret-token": "s3cret-s3cret-s3cret" }, "POST");
    assert.equal(r.status, 200);
    assert.equal(tgCalls, 1);
  });
  it("пустой WEBHOOK_SECRET → любой POST 401 (даже без заголовка и с пустым)", async () => {
    tgCalls = 0;
    const { get } = await start(baseDeps({ webhookSecret: "" }));
    assert.equal((await get("/hook", {}, "POST")).status, 401);
    assert.equal((await get("/hook", { "x-telegram-bot-api-secret-token": "anything" }, "POST")).status, 401);
    assert.equal(tgCalls, 0);
  });
  it("D13: tgHandler реджектит (битый JSON) → 400, без unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { get } = await start(
        baseDeps({
          tgHandler: async () => {
            throw new SyntaxError("Unexpected token");
          },
        }),
      );
      const r = await get("/hook", { "x-telegram-bot-api-secret-token": "s3cret-s3cret-s3cret" }, "POST");
      assert.equal(r.status, 400);
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
  it("localApi: webhook-роута нет → 404", async () => {
    const { get } = await start(baseDeps({ localApi: true }));
    assert.equal((await get("/hook", {}, "POST")).status, 404);
  });
});

describe("now-playing auth", () => {
  it("токен не задан → 401 disabled", async () => {
    const { get } = await start(baseDeps({ nowPlayingToken: "" }));
    const r = await get("/now-playing", { authorization: "Bearer " });
    assert.equal(r.status, 401);
    assert.deepEqual(JSON.parse(r.text), { error: "disabled" });
  });
  it("неверный → 401, верный → 200 с payload", async () => {
    const { get } = await start(baseDeps());
    assert.equal((await get("/now-playing")).status, 401);
    assert.equal((await get("/now-playing", { authorization: "Bearer nope" })).status, 401);
    const ok = await get("/now-playing", { authorization: "Bearer np-token" });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.text), { playing: false, recent: [] });
  });
  it("неизвестный путь → 404", async () => {
    const { get } = await start(baseDeps());
    assert.equal((await get("/nope")).status, 404);
  });
});

describe("/metrics и /health + METRICS_TOKEN", () => {
  it("токен пуст → открыто (обратная совместимость)", async () => {
    const { get } = await start(baseDeps());
    const m = await get("/metrics");
    assert.equal(m.status, 200);
    assert.match(m.text, /nowym_uptime_seconds/);
    const h = JSON.parse((await get("/health")).text);
    assert.equal(h.status, "ok");
    assert.ok(h.db && h.watcher && h.caches);
  });
  it("токен задан: /metrics без/с неверным Bearer → 401, верный → 200", async () => {
    const { get } = await start(baseDeps({ metricsToken: "mt" }));
    assert.equal((await get("/metrics")).status, 401);
    assert.equal((await get("/metrics", { authorization: "Bearer x" })).status, 401);
    assert.equal((await get("/metrics", { authorization: "Bearer mt" })).status, 200);
  });
  it("токен задан: /health без Bearer → только status, с Bearer → детали", async () => {
    const { get } = await start(baseDeps({ metricsToken: "mt" }));
    const bare = await get("/health");
    assert.equal(bare.status, 200);
    assert.deepEqual(JSON.parse(bare.text), { status: "ok" });
    assert.ok(JSON.parse((await get("/health", { authorization: "Bearer mt" })).text).db);
  });
  it("БД лежит → 503 degraded; в теле нет секретов", async () => {
    const { get } = await start(baseDeps({ usersPool: pool(false) }));
    const r = await get("/health");
    assert.equal(r.status, 503);
    assert.equal(JSON.parse(r.text).status, "degraded");
    for (const secret of ["np-token", "s3cret-s3cret-s3cret"]) assert.ok(!r.text.includes(secret));
  });
});

/** Открывает SSE и возвращает, когда пришёл первый чанк. */
function openSse(port: number, token = "np-token"): Promise<{ closed: Promise<void>; destroy: () => void }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/now-playing/stream", headers: { authorization: `Bearer ${token}` } },
      (res) => {
        const closed = new Promise<void>((r) => {
          res.on("close", () => r());
          res.on("error", () => r());
        });
        res.once("data", () => resolve({ closed, destroy: () => req.destroy() }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("SSE", () => {
  it("лимит соединений → 429", async () => {
    const { port, get } = await start(baseDeps({ streamMaxConnections: 1 }));
    await openSse(port);
    const r = await get("/now-playing/stream", { authorization: "Bearer np-token" });
    assert.equal(r.status, 429);
  });

  it("shutdown с открытым SSE-клиентом завершается быстро", async () => {
    const { port, app, server: srv } = await start(baseDeps());
    const client = await openSse(port);
    const t0 = Date.now();
    await Promise.race([
      closeServer(srv, app),
      new Promise((_, rej) => setTimeout(() => rej(new Error("shutdown завис")), 3000)),
    ]);
    assert.ok(Date.now() - t0 < 2000);
    await client.closed;
    server = null;
  });

  it("без closeServer server.close() с SSE-клиентом не завершается (контроль)", async () => {
    const { port, server: srv } = await start(baseDeps());
    await openSse(port);
    const r = await Promise.race([
      new Promise<string>((res) => srv.close(() => res("closed"))),
      new Promise<string>((res) => setTimeout(() => res("hung"), 300)),
    ]);
    assert.equal(r, "hung");
  });
});
