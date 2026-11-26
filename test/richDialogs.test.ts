/** Окно настроек rich messages (s_rich): тексты, маппинг on/off, сохранение (без сети/БД). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Bot } from "gramio";
import type { Container } from "../src/bot/container.ts";
import {
  buildMenuDialog,
  radioOnClick,
  richCurrent,
  richLabel,
  richPickText,
  richSave,
  settingsMainText,
} from "../src/bot/dialogs.ts";
import type { UserSettings } from "../src/storage/settings.ts";

const base = {
  track_layout: "button",
  track_send_mode: "stub",
  track_quality: "best",
  card_layout: "button",
  card_progress: "wavy",
  card_aspect: "16:9",
  card_toggles: { album: true, type: false, year: true, label: false, track_no: false, avatar: true },
  rich_messages: false,
} as unknown as UserSettings;

function fakeContainer() {
  const calls: Array<[number, boolean]> = [];
  const invalidated: number[] = [];
  const container = {
    settingsDb: {
      setRichMessages: async (u: number, v: boolean) => {
        calls.push([u, v]);
        return v;
      },
    },
    invalidateUserSettings: (u: number) => invalidated.push(u),
  } as unknown as Container;
  return { container, calls, invalidated };
}

test("richLabel / richCurrent: on/off <-> boolean, default off", () => {
  assert.equal(richLabel("on"), "вкл.");
  assert.equal(richLabel("off"), "выкл.");
  assert.equal(richCurrent({ ...base, rich_messages: true }), "on");
  assert.equal(richCurrent({ ...base, rich_messages: false }), "off");
});

test("richSave: пишет boolean нужному юзеру и возвращает применённое значение", async () => {
  const { container, calls } = fakeContainer();
  assert.equal(await richSave(container, 7, "on"), "on");
  assert.equal(await richSave(container, 8, "off"), "off");
  assert.deepEqual(calls, [
    [7, true],
    [8, false],
  ]);
});

test("radioOnClick: сохраняет, инвалидирует кэш юзера, затем show()", async () => {
  const { container, calls, invalidated } = fakeContainer();
  const order: string[] = [];
  const ctx = {
    from: { id: 42 },
    answerCallbackQuery: async () => order.push("answer"),
    show: async () => order.push("show"),
  };
  await radioOnClick(container, richLabel, (u, v) => richSave(container, u, v))(ctx as never, "on");
  assert.deepEqual(calls, [[42, true]]);
  assert.deepEqual(invalidated, [42]);
  assert.equal(order.at(-1), "show");
});

test("тексты: главная строка и окно s_rich", () => {
  const on = settingsMainText({ ...base, rich_messages: true }).toString();
  const off = settingsMainText(base).toString();
  assert.match(on, /карточка\+трек: вкл\./);
  assert.match(off, /карточка\+трек: выкл\./);
  const t = richPickText().toString();
  assert.match(t, /Rich messages \(карточка \+ трек\)/);
  assert.match(t, /одним сообщением/);
  assert.match(t, /как раньше/);
});

test("окно s_rich зарегистрировано сразу после s_sendmode и доступно из настроек", async () => {
  const dialog = buildMenuDialog({} as Bot, {} as Container);
  assert.equal(dialog.siblingState("s_sendmode", 1), "s_rich");
  type Btn = {
    id: string;
    text: { renderText(rc: unknown): Promise<unknown> };
    processCallback(id: string, payload: unknown, mgr: unknown): Promise<boolean>;
  };
  const buttons: Btn[] = [];
  const walk = (o: unknown): void => {
    if (!o || typeof o !== "object") return;
    const w = o as { children?: unknown[]; processCallback?: unknown; text?: unknown };
    if (Array.isArray(w.children)) w.children.forEach(walk);
    else if (typeof w.processCallback === "function" && w.text) buttons.push(o as Btn);
  };
  walk(dialog.getWindow("settings").keyboard);
  const texts = await Promise.all(buttons.map(async (b) => String(await b.text.renderText({}))));
  const iSend = texts.findIndex((t) => t.includes("тип отправки"));
  const iRich = texts.findIndex((t) => t.includes("карточка+трек"));
  const iQuality = texts.findIndex((t) => t.includes("качество"));
  assert.ok(iSend >= 0 && iRich === iSend + 1 && iQuality === iRich + 1, texts.join("|"));
  let target = "";
  const clickCtx = {
    dialog: {
      switchTo: async (s: string) => {
        target = s;
      },
    },
  };
  await buttons[iRich]!.processCallback(buttons[iRich]!.id, undefined, { clickCtx });
  assert.equal(target, "s_rich");
  assert.ok(dialog.getWindow("s_rich"));
});
