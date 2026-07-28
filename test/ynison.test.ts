/** Тесты Ynison: liveProgressMs (интерполяция/клампы), билдеры запросов
 * (структура сверена с betterproto-json из venv) и парсер state-фрейма.
 *
 * Live ws не тестируем — нет кредов; фокус на чистой логике и форме payload'ов. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { liveProgressMs } from "../src/yandex/ynison.ts";
import {
  buildUpdateFullStateRequest,
  generateDeviceId,
  generateRequestId,
  parseStateFrame,
  parseRedirectFrame,
  ANDROID_DEVICE_INFO,
  type DeviceInfoOverride,
} from "@dvxch/yandex-music";

// идентитет наблюдателя, как его собирает nowPlayingWatcher.
const WATCHER_DEVICE_INFO: DeviceInfoOverride = { ...ANDROID_DEVICE_INFO, title: "Мойва" };

// ── liveProgressMs ──────────────────────────────────────────────────────────

test("liveProgressMs: на паузе возвращает снимок без интерполяции", () => {
  assert.equal(liveProgressMs(42_000, 200_000, true, Date.now() - 10_000), 42_000);
});

test("liveProgressMs: ts=0 → без интерполяции (снимок как есть)", () => {
  assert.equal(liveProgressMs(42_000, 200_000, false, 0), 42_000);
});

test("liveProgressMs: играет — двигает позицию вперёд на прошедшее время", () => {
  const ts = Date.now() - 5_000; // 5с назад
  const r = liveProgressMs(10_000, 200_000, false, ts);
  // ~15000 ± погрешность планировщика
  assert.ok(r >= 14_900 && r <= 15_200, `ожидал ~15000, получил ${r}`);
});

test("liveProgressMs: клампит к duration", () => {
  const ts = Date.now() - 100_000; // ушли бы далеко за конец
  assert.equal(liveProgressMs(190_000, 200_000, false, ts), 200_000);
});

test("liveProgressMs: учитывает playback_speed", () => {
  const ts = Date.now() - 4_000;
  const r = liveProgressMs(0, 200_000, false, ts, 2.0);
  assert.ok(r >= 7_900 && r <= 8_200, `ожидал ~8000, получил ${r}`);
});

test("liveProgressMs: отрицательный снимок клампится к 0", () => {
  assert.equal(liveProgressMs(-5_000, 200_000, true, 0), 0);
});

test("liveProgressMs: duration=0 — не клампит (прогресс как есть)", () => {
  const ts = Date.now() - 3_000;
  const r = liveProgressMs(1_000, 0, false, ts);
  assert.ok(r >= 3_900 && r <= 4_200, `ожидал ~4000, получил ${r}`);
});

// ── билдеры запросов ──────────────────────────────────────────────────────────

// эталон из venv:
//   get_update_full_state_request('test-device-id').to_json()
// rid — случайный UUID, сравниваем структуру без него.
const PY_DEFAULT = {
  updateFullState: {
    playerState: {
      status: { paused: true, playbackSpeed: 1, version: { deviceId: "test-device-id" } },
      playerQueue: {
        entityType: "VARIOUS",
        currentPlayableIndex: -1,
        options: { repeatMode: "NONE" },
        version: { deviceId: "test-device-id" },
        fromOptional: "",
      },
    },
    device: {
      info: { deviceId: "test-device-id", title: "Node.js SDK", type: "WEB", appName: "yandex-music" },
      capabilities: { canBeRemoteController: true },
      volumeInfo: {},
    },
  },
};

// эталон watcher (info.type=ANDROID, app_name/version/title подменены):
const PY_WATCHER_INFO = {
  deviceId: "test-device-id",
  title: "Мойва",
  type: "ANDROID",
  appName: "ru.yandex.music",
  appVersion: "2026.05.3",
};

test("buildUpdateFullStateRequest (default): структура совпадает с Python", () => {
  const req = buildUpdateFullStateRequest("test-device-id");
  assert.equal(typeof req.rid, "string");
  assert.ok(req.rid.length > 0);
  const { rid, ...rest } = req;
  void rid;
  assert.deepEqual(rest, PY_DEFAULT);
});

test("buildUpdateFullStateRequest (watcher): info = Android-идентитет", () => {
  const req = buildUpdateFullStateRequest("test-device-id", WATCHER_DEVICE_INFO);
  assert.deepEqual(req.updateFullState.device.info, PY_WATCHER_INFO);
  // остальное (status/playerQueue/capabilities) идентично default'у
  assert.deepEqual(req.updateFullState.playerState, PY_DEFAULT.updateFullState.playerState);
  assert.deepEqual(
    req.updateFullState.device.capabilities,
    PY_DEFAULT.updateFullState.device.capabilities,
  );
});

test("buildUpdateFullStateRequest: сериализуется в валидный JSON без лишних полей", () => {
  const req = buildUpdateFullStateRequest("dev-x");
  const parsed = JSON.parse(JSON.stringify(req));
  // playerActionTimestampMs/isCurrentlyActive/canBePlayer и т.п. опущены (как betterproto)
  assert.ok(!("playerActionTimestampMs" in parsed));
  assert.ok(!("isCurrentlyActive" in parsed.updateFullState));
  assert.ok(!("canBePlayer" in parsed.updateFullState.device.capabilities));
});

test("generateDeviceId: непустой hex", () => {
  const id = generateDeviceId();
  assert.match(id, /^[0-9a-f]+$/);
});

test("generateRequestId: валидный uuid4", () => {
  assert.match(
    generateRequestId(),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

// ── парсер state-фрейма ──────────────────────────────────────────────────────

// эталон PutYnisonStateResponse.to_json() из venv (int64 строками):
const SAMPLE_STATE = JSON.stringify({
  playerState: {
    status: {
      progressMs: "42000",
      durationMs: "200000",
      playbackSpeed: 1.0,
      version: { deviceId: "dev", timestampMs: "1716900000000" },
    },
    playerQueue: {
      entityId: "49",
      entityType: "ALBUM",
      playableList: [
        { playableId: "123456", playableType: "TRACK", title: "t1" },
        { playableId: "789", playableType: "TRACK", title: "t2" },
      ],
    },
  },
  timestampMs: "1716900000000",
  rid: "abc",
});

test("parseStateFrame: int64-строки коэрсятся в number, currentIndex по умолчанию 0", () => {
  const s = parseStateFrame(SAMPLE_STATE);
  assert.equal(s.progressMs, 42_000);
  assert.equal(s.durationMs, 200_000);
  assert.equal(s.timestampMs, 1_716_900_000_000);
  assert.equal(s.playbackSpeed, 1);
  assert.equal(s.paused, false); // paused опущен → false
  assert.equal(s.currentPlayableIndex, 0); // currentPlayableIndex опущен → 0
  assert.equal(s.entityId, "49");
  assert.equal(s.entityType, "ALBUM");
  assert.equal(s.playableList.length, 2);
  assert.equal(s.playableList[0]?.playableId, "123456");
});

test("parseStateFrame: 'не играет' (idx=-1, пустые поля)", () => {
  const frame = JSON.stringify({
    playerState: { status: { paused: true }, playerQueue: { currentPlayableIndex: -1 } },
  });
  const s = parseStateFrame(frame);
  assert.equal(s.currentPlayableIndex, -1);
  assert.equal(s.paused, true);
  assert.equal(s.playableList.length, 0);
  assert.equal(s.progressMs, 0);
});

test("parseRedirectFrame: достаёт host/ticket/sessionId (int64 строкой)", () => {
  const frame = JSON.stringify({
    host: "ynison-x.music.yandex.ru",
    redirectTicket: "tkt-123",
    sessionId: "9876543210",
  });
  const r = parseRedirectFrame(frame);
  assert.equal(r.host, "ynison-x.music.yandex.ru");
  assert.equal(r.redirectTicket, "tkt-123");
  assert.equal(r.sessionId, "9876543210");
});

test("parseRedirectFrame: бросает на неполном фрейме", () => {
  assert.throws(() => parseRedirectFrame(JSON.stringify({ host: "x" })));
});
