import assert from "node:assert/strict";
import { test } from "node:test";
import { DeviceAuthError } from "@dvxch/yandex-music";

// AuthService читает getSettings() (YANDEX_OAUTH_CLIENT_ID/SECRET) — settings.ts
// валидирует обязательные переменные лениво при первом вызове. Задаём их здесь,
// т.к. это первый тестовый файл, реально доходящий до getSettings(). Node
// запускает каждый тестовый файл в своём процессе — на другие файлы не влияет.
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHANNEL_ID = "test-channel";
process.env.TOKEN_ENCRYPTION_KEY = "test-key";
process.env.POSTGRES_USERS_DSN = "postgres://test/test";
process.env.POSTGRES_CACHE_DSN = "postgres://test/test";
// один из двух обязателен (см. settings.ts validate) — иначе тест падает не на
// том, что реально проверяет, а на отсутствии .env у того, кто просто клонировал репо
process.env.BOT_API_BASE_URL = "http://127.0.0.1:8081/bot";

import { AuthService, type DeviceAuthTransport } from "../src/services/auth.ts";
import type { UsersDb } from "../src/storage/users.ts";

/** фейковые часы: sleep не ждёт, а двигает время и записывает запрошенные паузы */
function fastClock(startMs = 1_000_000): {
  sleeps: number[];
  opts: { sleepFn: (ms: number) => Promise<void>; now: () => number };
} {
  let t = startMs;
  const sleeps: number[] = [];
  return {
    sleeps,
    opts: {
      sleepFn: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
      now: () => t,
    },
  };
}

function mkUsersDb(): {
  db: UsersDb;
  saved: Array<{ userId: number; access: string; refresh: string | null; expires: number | null }>;
} {
  const saved: Array<{ userId: number; access: string; refresh: string | null; expires: number | null }> = [];
  const db = {
    save: async (userId: number, access: string, refresh: string | null = null, expires: number | null = null) => {
      saved.push({ userId, access, refresh, expires });
    },
  };
  return { db: db as unknown as UsersDb, saved };
}

test("startDeviceAuth → pollDeviceTokenOnce отдаёт токен сразу — onSuccess, запись в БД", async () => {
  const { db, saved } = mkUsersDb();
  const lib: DeviceAuthTransport = {
    requestDeviceCode: async () =>
      ({
        deviceCode: "dc-1",
        userCode: "US-1234",
        verificationUrl: "https://ya.ru/auth",
        expiresIn: 300,
        interval: 3,
      }) as never,
    pollDeviceTokenOnce: async () => ({ accessToken: "AT1", refreshToken: "RT1", expiresIn: 3600 }) as never,
    refreshAccessToken: async () => {
      throw new Error("не должен вызываться");
    },
  };
  const auth = new AuthService(db, lib, fastClock().opts);

  let successUserId: number | null = null;
  let failure: string | null = null;
  const state = await auth.startDeviceAuth(
    42,
    (uid) => {
      successUserId = uid;
    },
    (_uid, reason) => {
      failure = reason;
    },
  );

  assert.ok(state);
  assert.equal(state!.userCode, "US-1234");
  assert.equal(state!.verificationUrl, "https://ya.ru/auth");
  await state!.done;

  assert.equal(successUserId, 42);
  assert.equal(failure, null);
  assert.deepEqual(saved, [{ userId: 42, access: "AT1", refresh: "RT1", expires: 3600 }]);
  assert.equal(auth.isPending(42), false); // запись снята после завершения
});

test("pollLoop — authorization_pending ('pending') продолжает опрос до успеха", async () => {
  const { db, saved } = mkUsersDb();
  let calls = 0;
  const lib: DeviceAuthTransport = {
    requestDeviceCode: async () =>
      ({ deviceCode: "dc-2", userCode: "US-2", verificationUrl: "u", expiresIn: 300, interval: 3 }) as never,
    pollDeviceTokenOnce: async () => {
      calls += 1;
      return calls < 2 ? "pending" : ({ accessToken: "AT2", refreshToken: null, expiresIn: null } as never);
    },
    refreshAccessToken: async () => {
      throw new Error("не должен вызываться");
    },
  };
  const auth = new AuthService(db, lib, fastClock().opts);

  let ok = false;
  const state = await auth.startDeviceAuth(
    7,
    () => {
      ok = true;
    },
    () => {},
  );
  await state!.done;

  assert.equal(calls, 2);
  assert.equal(ok, true);
  assert.deepEqual(saved, [{ userId: 7, access: "AT2", refresh: null, expires: null }]);
});

test("pollLoop — DeviceAuthError → onFailure с причиной, в БД ничего не пишется", async () => {
  const { db, saved } = mkUsersDb();
  const lib: DeviceAuthTransport = {
    requestDeviceCode: async () =>
      ({ deviceCode: "dc-3", userCode: "US-3", verificationUrl: "u", expiresIn: 300, interval: 3 }) as never,
    pollDeviceTokenOnce: async () => {
      throw new DeviceAuthError("access_denied");
    },
    refreshAccessToken: async () => {
      throw new Error("не должен вызываться");
    },
  };
  const auth = new AuthService(db, lib, fastClock().opts);

  let reason: string | null = null;
  const state = await auth.startDeviceAuth(
    9,
    () => {
      throw new Error("не должен вызываться");
    },
    (_uid, r) => {
      reason = r;
    },
  );
  await state!.done;

  assert.equal(reason, "access_denied");
  assert.deepEqual(saved, []);
});

test("startDeviceAuth → requestDeviceCode падает — возвращает null, не запускает поллинг", async () => {
  const { db } = mkUsersDb();
  const lib: DeviceAuthTransport = {
    requestDeviceCode: async () => {
      throw new Error("сеть недоступна");
    },
    pollDeviceTokenOnce: async () => {
      throw new Error("не должен вызываться");
    },
    refreshAccessToken: async () => {
      throw new Error("не должен вызываться");
    },
  };
  const auth = new AuthService(db, lib, fastClock().opts);
  const state = await auth.startDeviceAuth(
    1,
    () => {},
    () => {},
  );
  assert.equal(state, null);
  assert.equal(auth.isPending(1), false);
});

test("refreshToken — успех сохраняет новый access, переиспользует старый refresh если новый не пришёл", async () => {
  const { db, saved } = mkUsersDb();
  const lib: DeviceAuthTransport = {
    requestDeviceCode: async () => {
      throw new Error("не должен вызываться");
    },
    pollDeviceTokenOnce: async () => {
      throw new Error("не должен вызываться");
    },
    refreshAccessToken: async () => ({ accessToken: "NEW_AT", refreshToken: undefined, expiresIn: 1800 }) as never,
  };
  const auth = new AuthService(db, lib, fastClock().opts);
  const result = await auth.refreshToken(5, "OLD_RT");
  assert.equal(result, "NEW_AT");
  assert.deepEqual(saved, [{ userId: 5, access: "NEW_AT", refresh: "OLD_RT", expires: 1800 }]);
});

test("refreshToken — библиотека бросает → null, ничего не сохраняется", async () => {
  const { db, saved } = mkUsersDb();
  const lib: DeviceAuthTransport = {
    requestDeviceCode: async () => {
      throw new Error("не должен вызываться");
    },
    pollDeviceTokenOnce: async () => {
      throw new Error("не должен вызываться");
    },
    refreshAccessToken: async () => {
      throw new DeviceAuthError("invalid_grant");
    },
  };
  const auth = new AuthService(db, lib, fastClock().opts);
  const result = await auth.refreshToken(5, "OLD_RT");
  assert.equal(result, null);
  assert.deepEqual(saved, []);
});

const codeOf =
  (expiresIn: number, interval = 3) =>
  async () =>
    ({ deviceCode: "dc", userCode: "US", verificationUrl: "u", expiresIn, interval }) as never;
const noRefresh = async () => {
  throw new Error("не должен вызываться");
};

test("pollLoop — pending, pending, токен: интервал не меняется", async () => {
  const { db, saved } = mkUsersDb();
  const outcomes: unknown[] = ["pending", "pending", { accessToken: "AT", refreshToken: "RT", expiresIn: 10 }];
  const lib: DeviceAuthTransport = {
    requestDeviceCode: codeOf(300),
    pollDeviceTokenOnce: async () => outcomes.shift() as never,
    refreshAccessToken: noRefresh,
  };
  const clock = fastClock();
  const auth = new AuthService(db, lib, clock.opts);
  const state = await auth.startDeviceAuth(
    1,
    () => {},
    () => {},
  );
  await state!.done;
  assert.deepEqual(clock.sleeps, [3000, 3000, 3000]);
  assert.equal(saved.length, 1);
});

test("pollLoop — slow_down увеличивает интервал на 5 с каждый раз (RFC 8628)", async () => {
  const { db, saved } = mkUsersDb();
  const outcomes: unknown[] = [
    "slow_down",
    "slow_down",
    "pending",
    { accessToken: "AT", refreshToken: null, expiresIn: null },
  ];
  const lib: DeviceAuthTransport = {
    requestDeviceCode: codeOf(300),
    pollDeviceTokenOnce: async () => outcomes.shift() as never,
    refreshAccessToken: noRefresh,
  };
  const clock = fastClock();
  const auth = new AuthService(db, lib, clock.opts);
  let ok = false;
  const state = await auth.startDeviceAuth(
    1,
    () => {
      ok = true;
    },
    () => {},
  );
  await state!.done;
  assert.deepEqual(clock.sleeps, [3000, 8000, 13000, 13000]);
  assert.equal(ok, true);
  assert.equal(saved[0]?.access, "AT");
});

test("pollLoop — дедлайн соблюдается при постоянном slow_down: timeout, мало опросов", async () => {
  const { db, saved } = mkUsersDb();
  let polls = 0;
  const lib: DeviceAuthTransport = {
    requestDeviceCode: codeOf(10),
    pollDeviceTokenOnce: async () => {
      polls += 1;
      return "slow_down" as never;
    },
    refreshAccessToken: noRefresh,
  };
  const auth = new AuthService(db, lib, fastClock().opts);
  let reason: string | null = null;
  const state = await auth.startDeviceAuth(
    1,
    () => {},
    (_u, r) => {
      reason = r;
    },
  );
  await state!.done;
  assert.equal(reason, "timeout");
  assert.ok(polls <= 3, `polls=${polls}`);
  assert.deepEqual(saved, []);
});

test("pollLoop — ответ токена не распарсился → onFailure с причиной из библиотеки", async () => {
  const { db, saved } = mkUsersDb();
  const lib: DeviceAuthTransport = {
    requestDeviceCode: codeOf(300),
    pollDeviceTokenOnce: async () => {
      throw new DeviceAuthError("failed to parse token response");
    },
    refreshAccessToken: noRefresh,
  };
  const auth = new AuthService(db, lib, fastClock().opts);
  let reason: string | null = null;
  const state = await auth.startDeviceAuth(
    1,
    () => {},
    (_u, r) => {
      reason = r;
    },
  );
  await state!.done;
  assert.equal(reason, "failed to parse token response");
  assert.deepEqual(saved, []);
});

test("cancelAuth — отмена останавливает опрос без onSuccess/onFailure", async () => {
  const { db, saved } = mkUsersDb();
  let polls = 0;
  const lib: DeviceAuthTransport = {
    requestDeviceCode: codeOf(300),
    pollDeviceTokenOnce: async () => {
      polls += 1;
      return "pending" as never;
    },
    refreshAccessToken: noRefresh,
  };
  const clock = fastClock();
  const auth: AuthService = new AuthService(db, lib, {
    ...clock.opts,
    sleepFn: async (ms) => {
      await clock.opts.sleepFn(ms);
      auth.cancelAuth(1);
    },
  });
  let called = false;
  const state = await auth.startDeviceAuth(
    1,
    () => {
      called = true;
    },
    () => {
      called = true;
    },
  );
  await state!.done;
  assert.equal(polls, 0);
  assert.equal(called, false);
  assert.deepEqual(saved, []);
});

test("refreshToken — библиотека бросает DeviceAuthError (нет accessToken) → null", async () => {
  const { db, saved } = mkUsersDb();
  const lib: DeviceAuthTransport = {
    requestDeviceCode: noRefresh,
    pollDeviceTokenOnce: noRefresh,
    refreshAccessToken: async () => {
      throw new DeviceAuthError("failed to parse refresh token response");
    },
  };
  const auth = new AuthService(db, lib, fastClock().opts);
  assert.equal(await auth.refreshToken(5, "RT"), null);
  assert.deepEqual(saved, []);
});

test("D4: cancelAuth, пока poll в полёте, — пришедший токен не сохраняется", async () => {
  const { db, saved } = mkUsersDb();
  let auth!: AuthService;
  const lib: DeviceAuthTransport = {
    requestDeviceCode: codeOf(300),
    pollDeviceTokenOnce: async () => {
      // logout/«отмена» прилетает ровно во время сетевого запроса
      auth.cancelAuth(1);
      return { accessToken: "AT", refreshToken: "RT", expiresIn: 10 } as never;
    },
    refreshAccessToken: noRefresh,
  };
  auth = new AuthService(db, lib, fastClock().opts);
  let called = false;
  const state = await auth.startDeviceAuth(
    1,
    () => {
      called = true;
    },
    () => {
      called = true;
    },
  );
  await state!.done;
  assert.deepEqual(saved, [], "токен после отмены не должен попасть в БД");
  assert.equal(called, false, "ни onSuccess, ни onFailure");
});

test("D5: двойной тап «войти» — первый поток отменяется, токен сохраняет только последний", async () => {
  const { db, saved } = mkUsersDb();
  // первый requestDeviceCode отвечает позже второго: оба start'а проходят
  // проверку existing до того, как кто-то из них записался в active.
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((r) => {
    releaseFirst = r;
  });
  let reqN = 0;
  const lib: DeviceAuthTransport = {
    requestDeviceCode: async () => {
      reqN += 1;
      const n = reqN;
      if (n === 1) await firstGate;
      return { deviceCode: `dc${n}`, userCode: `U${n}`, verificationUrl: "u", expiresIn: 300, interval: 3 } as never;
    },
    pollDeviceTokenOnce: async (deviceCode: string) => ({ accessToken: `AT-${deviceCode}` }) as never,
    refreshAccessToken: noRefresh,
  };
  // poll-циклы стоят на первом sleep, пока оба start'а не отработали (в жизни
  // интервал опроса ≥3с, а requestDeviceCode — сотни мс).
  let releasePolls!: () => void;
  const pollGate = new Promise<void>((r) => {
    releasePolls = r;
  });
  const clock = fastClock();
  const auth = new AuthService(db, lib, {
    ...clock.opts,
    sleepFn: async (ms) => {
      await pollGate;
      await clock.opts.sleepFn(ms);
    },
  });
  const successes: number[] = [];
  const onOk = (uid: number) => {
    successes.push(uid);
  };
  const p1 = auth.startDeviceAuth(1, onOk, () => {});
  const p2 = auth.startDeviceAuth(1, onOk, () => {});
  const s2 = await p2; // второй стартовал первым и уже в active
  releaseFirst();
  const s1 = await p1; // первый дошёл позже — он и есть «последний тап», второй отменяется
  releasePolls();
  await Promise.all([s1!.done, s2!.done]);
  assert.equal(saved.length, 1, "сохранение ровно одно");
  assert.equal(saved[0]!.access, "AT-dc1");
  assert.deepEqual(successes, [1]);
});
