/** Container.forceRefreshToken: принудительный refresh для наблюдателя (без проверки expires_at). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Container, resolveBotUsername } from "../src/bot/container.ts";

function mk(creds: { refresh_token: string | null } | null, refresh: (u: number, r: string) => Promise<string | null>) {
  const c = new Container() as unknown as Record<string, unknown>;
  const dropped: string[] = [];
  c.usersDb = { get: async () => creds };
  c.authService = { refreshToken: refresh };
  c.yandexClients = { delete: (k: string) => dropped.push(`c${k}`) };
  c.searchServices = { delete: (k: string) => dropped.push(`s${k}`) };
  return { container: c as unknown as Container, dropped };
}

test("forceRefreshToken: refresh даже при валидном expires_at, кэш клиента сброшен", async () => {
  const calls: Array<[number, string]> = [];
  const { container, dropped } = mk({ refresh_token: "R" }, async (u, r) => {
    calls.push([u, r]);
    return "NEW";
  });
  assert.equal(await container.forceRefreshToken(7), "NEW");
  assert.deepEqual(calls, [[7, "R"]]);
  assert.deepEqual(dropped, ["c7", "s7"]);
});

test("forceRefreshToken: параллельные вызовы дедуплицируются", async () => {
  let n = 0;
  const { container } = mk({ refresh_token: "R" }, async () => {
    n++;
    await new Promise((r) => setTimeout(r, 10));
    return "NEW";
  });
  await Promise.all([container.forceRefreshToken(7), container.forceRefreshToken(7)]);
  assert.equal(n, 1);
});

test("forceRefreshToken: не бросает (нет creds / нет refresh_token / refresh упал) → null", async () => {
  assert.equal(await mk(null, async () => "X").container.forceRefreshToken(7), null);
  assert.equal(await mk({ refresh_token: null }, async () => "X").container.forceRefreshToken(7), null);
  const boom = mk({ refresh_token: "R" }, async () => {
    throw new Error("boom");
  });
  assert.equal(await boom.container.forceRefreshToken(7), null);
});

test("D23: resolveBotUsername берёт bot.info после bot.init(), без второго getMe", async () => {
  let getMeCalls = 0;
  const api = {
    getMe: async () => {
      getMeCalls++;
      return { username: "fromGetMe" };
    },
  };
  assert.equal(await resolveBotUsername({ info: { username: "nowymbot" }, api } as never), "nowymbot");
  assert.equal(getMeCalls, 0);
  assert.equal(await resolveBotUsername({ info: undefined, api } as never), "fromGetMe", "фолбэк без init");
  assert.equal(getMeCalls, 1);
});
