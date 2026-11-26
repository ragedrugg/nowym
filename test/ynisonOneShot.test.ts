/** Одноразовый YnisonService против локального fake ws-сервера (127.0.0.1, без сети):
 * политика retry по типам ошибок, стабильный device id, отсутствие unhandled rejection. */

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, test } from "node:test";
import { deviceIdFromToken, type Client as LibClient } from "@dvxch/yandex-music";
import { WebSocketServer } from "ws";
import { oneShotDeviceId, YnisonService } from "../src/yandex/ynison.ts";

const TOKEN = "test-token-oneshot";
const STATE_FRAME = JSON.stringify({
  player_state: {
    player_queue: { playable_list: [{ playable_id: "1" }], current_playable_index: 0 },
    status: { paused: true, duration_ms: 1000, progress_ms: 0 },
  },
});

type Behavior = "ok" | "unauthorized" | "displaced" | "drop";
let behaviors: Behavior[] = [];
let attempts = 0;
let deviceIds: string[] = [];
let active = 0;
let maxActive = 0;
let wss: WebSocketServer;
let port = 0;
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);

function errorFrame(details: Record<string, string>, grpc: number): string {
  return JSON.stringify({ error: { message: "boom", grpc_code: grpc, details } });
}

before(async () => {
  process.on("unhandledRejection", onUnhandled);
  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  port = (wss.address() as AddressInfo).port;
  wss.on("connection", (ws, req) => {
    if (req.url?.startsWith("/state")) {
      // небольшая задержка первого кадра: без сериализации сессии гарантированно перекрылись бы
      setTimeout(() => ws.readyState === ws.OPEN && ws.send(STATE_FRAME), 40);
      ws.on("close", () => {
        active--;
      });
      return;
    }
    attempts++;
    active++;
    maxActive = Math.max(maxActive, active);

    const proto =
      String(req.headers["sec-websocket-protocol"] ?? "")
        .split(",")[2]
        ?.trim() ?? "";
    const inner = JSON.parse(decodeURIComponent(proto)) as Record<string, string>;
    deviceIds.push(inner["Ynison-Device-Id"] ?? "");
    const b = behaviors.shift() ?? "ok";
    if (b === "drop") return void ws.terminate();
    if (b === "unauthorized") return void ws.send(errorFrame({}, 16));
    if (b === "displaced") return void ws.send(errorFrame({ "ynison-error-code": "400090001" }, 3));
    ws.send(JSON.stringify({ host: "127.0.0.1", redirect_ticket: "t", session_id: "1" }));
  });
});

afterEach(() => {
  behaviors = [];
  attempts = 0;
  deviceIds = [];
  active = 0;
  maxActive = 0;
});

after(async () => {
  await new Promise((r) => setTimeout(r, 50));
  process.off("unhandledRejection", onUnhandled);
  await new Promise<void>((r) => wss.close(() => r()));
  assert.deepEqual(unhandled, [], "unhandled rejections");
});

function service(): YnisonService {
  return new YnisonService({ tracks: async () => [{ id: "1" }] } as unknown as LibClient, TOKEN, {
    redirectUrl: `ws://127.0.0.1:${port}/redirect`,
    stateUrl: () => `ws://127.0.0.1:${port}/state`,
    retryBackoffMs: 10,
  });
}

test("unauthorized: ровно одна попытка, понятная причина", async () => {
  behaviors = ["unauthorized", "ok"];
  await assert.rejects(service().getCurrentTrack(), /boom/);
  assert.equal(attempts, 1);
});

test("displaced: одна попытка", async () => {
  behaviors = ["displaced", "ok"];
  await assert.rejects(service().getCurrentTrack(), /boom/);
  assert.equal(attempts, 1);
});

test("транзиентная ошибка: один retry и успех", async () => {
  behaviors = ["drop", "ok"];
  const r = await service().getCurrentTrack();
  assert.equal(r.paused, true);
  assert.equal(attempts, 2);
});

test("device id стабилен между вызовами и отличается от id наблюдателя", async () => {
  const s = service();
  await s.probe();
  await s.probe();
  assert.equal(deviceIds.length, 2);
  assert.equal(deviceIds[0], deviceIds[1]);
  assert.match(deviceIds[0]!, /^[0-9a-f]{12}$/);
  // наблюдатель берёт generateDeviceId() (случайный) или, в перспективе, deviceIdFromToken(token).
  assert.equal(deviceIds[0], oneShotDeviceId(TOKEN));
  assert.notEqual(deviceIds[0], deviceIdFromToken(TOKEN));
});

test("параллельные вызовы сериализуются (иначе один id вытеснит другой)", async () => {
  const s = service();
  await Promise.all([s.probe(), s.probe()]);
  assert.equal(attempts, 2);
  // сессия = redirect-коннект (+1) ... закрытие state-сокета (-1); без цепочки maxActive == 2
  assert.equal(maxActive, 1, "две ws-сессии с одним deviceId не должны перекрываться");
});
