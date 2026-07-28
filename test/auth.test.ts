import { test } from "node:test";
import assert from "node:assert/strict";
import { DeviceAuthError } from "@dvxch/yandex-music";

// AuthService читает getSettings() (YANDEX_OAUTH_CLIENT_ID/SECRET) — settings.ts
// валидирует обязательные переменные лениво при первом вызове. Задаём их здесь,
// т.к. это первый тестовый файл, реально доходящий до getSettings(). Node
// запускает каждый тестовый файл в своём процессе — на другие файлы не влияет.
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.TELEGRAM_CHANNEL_ID ??= "test-channel";
process.env.TOKEN_ENCRYPTION_KEY ??= "test-key";
process.env.POSTGRES_USERS_DSN ??= "postgres://test/test";
process.env.POSTGRES_CACHE_DSN ??= "postgres://test/test";
// один из двух обязателен (см. settings.ts validate) — иначе тест падает не на
// том, что реально проверяет, а на отсутствии .env у того, кто просто клонировал репо
process.env.BOT_API_BASE_URL ??= "http://127.0.0.1:8081/bot";

import { AuthService, type DeviceAuthTransport } from "../src/services/auth.ts";
import type { UsersDb } from "../src/storage/users.ts";

function mkUsersDb(): { db: UsersDb; saved: Array<{ userId: number; access: string; refresh: string | null; expires: number | null }> } {
  const saved: Array<{ userId: number; access: string; refresh: string | null; expires: number | null }> = [];
  const db = {
    save: async (userId: number, access: string, refresh: string | null = null, expires: number | null = null) => {
      saved.push({ userId, access, refresh, expires });
    },
  };
  return { db: db as unknown as UsersDb, saved };
}

test("startDeviceAuth → pollDeviceToken отдаёт токен сразу — onSuccess, запись в БД", async () => {
  const { db, saved } = mkUsersDb();
  const lib: DeviceAuthTransport = {
    requestDeviceCode: async () => ({
      deviceCode: "dc-1", userCode: "US-1234", verificationUrl: "https://ya.ru/auth", expiresIn: 300, interval: 3,
    }) as never,
    pollDeviceToken: async () => ({ accessToken: "AT1", refreshToken: "RT1", expiresIn: 3600 }) as never,
    refreshAccessToken: async () => { throw new Error("не должен вызываться"); },
  };
  const auth = new AuthService(db, lib);

  let successUserId: number | null = null;
  let failure: string | null = null;
  const state = await auth.startDeviceAuth(42, (uid) => { successUserId = uid; }, (_uid, reason) => { failure = reason; });

  assert.ok(state);
  assert.equal(state!.userCode, "US-1234");
  assert.equal(state!.verificationUrl, "https://ya.ru/auth");
  await state!.done;

  assert.equal(successUserId, 42);
  assert.equal(failure, null);
  assert.deepEqual(saved, [{ userId: 42, access: "AT1", refresh: "RT1", expires: 3600 }]);
  assert.equal(auth.isPending(42), false); // запись снята после завершения
});

test("pollLoop — authorization_pending (null) продолжает опрос до успеха", async () => {
  const { db, saved } = mkUsersDb();
  let calls = 0;
  const lib: DeviceAuthTransport = {
    requestDeviceCode: async () => ({ deviceCode: "dc-2", userCode: "US-2", verificationUrl: "u", expiresIn: 300, interval: 3 }) as never,
    pollDeviceToken: async () => {
      calls += 1;
      return calls < 2 ? null : (({ accessToken: "AT2", refreshToken: null, expiresIn: null }) as never);
    },
    refreshAccessToken: async () => { throw new Error("не должен вызываться"); },
  };
  const auth = new AuthService(db, lib);

  let ok = false;
  const state = await auth.startDeviceAuth(7, () => { ok = true; }, () => {});
  await state!.done;

  assert.equal(calls, 2);
  assert.equal(ok, true);
  assert.deepEqual(saved, [{ userId: 7, access: "AT2", refresh: null, expires: null }]);
});

test("pollLoop — DeviceAuthError → onFailure с причиной, в БД ничего не пишется", async () => {
  const { db, saved } = mkUsersDb();
  const lib: DeviceAuthTransport = {
    requestDeviceCode: async () => ({ deviceCode: "dc-3", userCode: "US-3", verificationUrl: "u", expiresIn: 300, interval: 3 }) as never,
    pollDeviceToken: async () => { throw new DeviceAuthError("access_denied"); },
    refreshAccessToken: async () => { throw new Error("не должен вызываться"); },
  };
  const auth = new AuthService(db, lib);

  let reason: string | null = null;
  const state = await auth.startDeviceAuth(9, () => { throw new Error("не должен вызываться"); }, (_uid, r) => { reason = r; });
  await state!.done;

  assert.equal(reason, "access_denied");
  assert.deepEqual(saved, []);
});

test("startDeviceAuth → requestDeviceCode падает — возвращает null, не запускает поллинг", async () => {
  const { db } = mkUsersDb();
  const lib: DeviceAuthTransport = {
    requestDeviceCode: async () => { throw new Error("сеть недоступна"); },
    pollDeviceToken: async () => { throw new Error("не должен вызываться"); },
    refreshAccessToken: async () => { throw new Error("не должен вызываться"); },
  };
  const auth = new AuthService(db, lib);
  const state = await auth.startDeviceAuth(1, () => {}, () => {});
  assert.equal(state, null);
  assert.equal(auth.isPending(1), false);
});

test("refreshToken — успех сохраняет новый access, переиспользует старый refresh если новый не пришёл", async () => {
  const { db, saved } = mkUsersDb();
  const lib: DeviceAuthTransport = {
    requestDeviceCode: async () => { throw new Error("не должен вызываться"); },
    pollDeviceToken: async () => { throw new Error("не должен вызываться"); },
    refreshAccessToken: async () => ({ accessToken: "NEW_AT", refreshToken: undefined, expiresIn: 1800 }) as never,
  };
  const auth = new AuthService(db, lib);
  const result = await auth.refreshToken(5, "OLD_RT");
  assert.equal(result, "NEW_AT");
  assert.deepEqual(saved, [{ userId: 5, access: "NEW_AT", refresh: "OLD_RT", expires: 1800 }]);
});

test("refreshToken — библиотека бросает → null, ничего не сохраняется", async () => {
  const { db, saved } = mkUsersDb();
  const lib: DeviceAuthTransport = {
    requestDeviceCode: async () => { throw new Error("не должен вызываться"); },
    pollDeviceToken: async () => { throw new Error("не должен вызываться"); },
    refreshAccessToken: async () => { throw new DeviceAuthError("invalid_grant"); },
  };
  const auth = new AuthService(db, lib);
  const result = await auth.refreshToken(5, "OLD_RT");
  assert.equal(result, null);
  assert.deepEqual(saved, []);
});
