/** /login и /logout: ответ правит сообщение, которое только что отправил start(), а не шлёт второе.
 * morda: смена окна = setData(patch) + replace(state) — replace всегда правит сообщение диалога
 * на месте (аналог GramIO switchTo(..., { mode: ShowMode.Edit })). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Container } from "../src/bot/container.ts";
import { startLogin, startLogout } from "../src/bot/dialogs.ts";
import type { ApiBot as Bot } from "../src/bot/types.ts";

const mkDialog = () => {
  const calls: Array<{ state: string; opts: { data?: unknown } }> = [];
  let data: Record<string, unknown> = {};
  return {
    calls,
    dialog: {
      setData: async (patch: Record<string, unknown>) => {
        data = { ...data, ...patch };
      },
      // replace = правка на месте (не новое сообщение); data — то, что увидит окно
      replace: async (state: string) => void calls.push({ state, opts: { data } }),
    },
  };
};

test("startLogin: уже вошёл: одно окно login_done, правка на месте", async () => {
  const { dialog, calls } = mkDialog();
  const container = { usersDb: { getToken: async () => "tok" } } as unknown as Container;
  await startLogin(dialog as never, {} as Bot, container, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.state, "login_done");
  assert.equal((calls[0]!.opts.data as { alreadyIn?: boolean }).alreadyIn, true);
});

test("startLogin: незавершённый вход и провал старта тоже правят текущее сообщение", async () => {
  const pending = { userCode: "ABCD", verificationUrl: "https://x", expiresIn: 600 };
  const a = mkDialog();
  await startLogin(
    a.dialog as never,
    {} as Bot,
    {
      usersDb: { getToken: async () => null },
      authService: { isPending: () => true, getState: () => pending },
    } as unknown as Container,
    1,
  );
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0]!.state, "login");
  assert.equal((a.calls[0]!.opts.data as { login?: { userCode: string } }).login?.userCode, "ABCD");

  const b = mkDialog();
  await startLogin(
    b.dialog as never,
    {} as Bot,
    {
      usersDb: { getToken: async () => null },
      authService: { isPending: () => false, startDeviceAuth: async () => null },
    } as unknown as Container,
    1,
  );
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0]!.state, "login_fail");
});

test("startLogout: правка на месте", async () => {
  const { dialog, calls } = mkDialog();
  const cancelled: number[] = [];
  const forgotten: number[] = [];
  const container = {
    usersDb: { delete: async () => true },
    authService: { cancelAuth: (id: number) => void cancelled.push(id) },
    invalidateTokenCacheForUser: () => {},
    albumService: { forgetUser: (id: number) => void forgotten.push(id) },
  } as unknown as Container;
  await startLogout(dialog as never, container, 1);
  assert.deepEqual(cancelled, [1], "незавершённый device-flow отменяется");
  assert.deepEqual(forgotten, [1], "D17: retry-буфер альбомов с токеном юзера чистится");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.state, "logout_done");
});

test("device-flow: успех рендерит login_done через background(api, String(uid)) извне хендлера", async () => {
  const bg = mkDialog();
  const keys: string[] = [];
  let onSuccess!: (uid: number) => Promise<void>;
  const container = {
    botUsername: "nowymbot",
    usersDb: { getToken: async () => null },
    authService: {
      isPending: () => false,
      startDeviceAuth: async (_uid: number, ok: (uid: number) => Promise<void>) => {
        onSuccess = ok;
        return { userCode: "C", verificationUrl: "https://x", expiresIn: 300 };
      },
    },
    invalidateTokenCacheForUser: () => {},
    dialogs: {
      background: async (_api: unknown, key: string) => {
        keys.push(key);
        return bg.dialog;
      },
    },
  } as unknown as Container;
  const fg = mkDialog();
  await startLogin(fg.dialog as never, { api: {} } as Bot, container, 7);
  assert.equal(fg.calls[0]!.state, "login");
  await onSuccess(7);
  assert.deepEqual(keys, ["7"], "ключ background = id чата лички (дефолтный getKey morda)");
  assert.equal(bg.calls[0]!.state, "login_done");
  assert.match(String((bg.calls[0]!.opts.data as { loginMsg?: string }).loginMsg), /./);
});
