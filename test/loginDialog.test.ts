/** /login и /logout: ответ правит сообщение, которое только что отправил start(), а не шлёт второе. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ShowMode } from "@gramio/dialogs";
import type { Bot } from "gramio";
import type { Container } from "../src/bot/container.ts";
import { startLogin, startLogout } from "../src/bot/dialogs.ts";

const mkDialog = () => {
  const calls: Array<{ state: string; opts: { mode?: unknown; data?: unknown } }> = [];
  return {
    calls,
    dialog: { switchTo: async (state: string, opts: { mode?: unknown }) => void calls.push({ state, opts }) },
  };
};

test("startLogin: уже вошёл: одно окно login_done, режим Edit", async () => {
  const { dialog, calls } = mkDialog();
  const container = { usersDb: { getToken: async () => "tok" } } as unknown as Container;
  await startLogin(dialog as never, {} as Bot, container, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.state, "login_done");
  assert.equal(calls[0]!.opts.mode, ShowMode.Edit);
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
  assert.equal(a.calls[0]!.state, "login");
  assert.equal(a.calls[0]!.opts.mode, ShowMode.Edit);

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
  assert.equal(b.calls[0]!.state, "login_fail");
  assert.equal(b.calls[0]!.opts.mode, ShowMode.Edit);
});

test("startLogout: режим Edit", async () => {
  const { dialog, calls } = mkDialog();
  const cancelled: number[] = [];
  const container = {
    usersDb: { delete: async () => true },
    authService: { cancelAuth: (id: number) => void cancelled.push(id) },
    invalidateTokenCacheForUser: () => {},
  } as unknown as Container;
  await startLogout(dialog as never, container, 1);
  assert.deepEqual(cancelled, [1], "незавершённый device-flow отменяется");
  assert.equal(calls[0]!.state, "logout_done");
  assert.equal(calls[0]!.opts.mode, ShowMode.Edit);
});
