/** Настройка rich messages (тумблер в разделе «карточка»): тексты, маппинг on/off, сохранение (без сети/БД). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Bot } from "gramio";
import type { Container } from "../src/bot/container.ts";
import {
  buildMenuDialog,
  radioOnClick,
  richCurrent,
  richLabel,
  richSave,
  richToggleOnClick,
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
  assert.equal(richLabel("on"), "вкл");
  assert.equal(richLabel("off"), "выкл");
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

test("тексты: главная строка настроек показывает карточка+трек", () => {
  const on = settingsMainText({ ...base, rich_messages: true }).toString();
  const off = settingsMainText(base).toString();
  assert.match(on, /карточка\+трек: вкл/);
  assert.match(off, /карточка\+трек: выкл/);
});

type Btn = {
  id: string;
  text: { renderText(rc: unknown): Promise<unknown> };
  processCallback(id: string, payload: unknown, mgr: unknown): Promise<boolean>;
};
const buttonsOf = (keyboard: unknown): Btn[] => {
  const out: Btn[] = [];
  const walk = (o: unknown): void => {
    if (!o || typeof o !== "object") return;
    const w = o as { children?: unknown[]; processCallback?: unknown; text?: unknown };
    if (Array.isArray(w.children)) w.children.forEach(walk);
    else if (typeof w.processCallback === "function" && w.text) out.push(o as Btn);
  };
  walk(keyboard);
  return out;
};
const labelsOf = (btns: Btn[], data: unknown) =>
  Promise.all(btns.map(async (b) => String(await b.text.renderText({ data }))));

test("настройки: два раздела, «карточка+трек» живёт внутри «карточка», окна s_rich нет", async () => {
  const dialog = buildMenuDialog({} as Bot, {} as Container);
  const top = await labelsOf(buttonsOf(dialog.getWindow("settings").keyboard), { s: base });
  assert.ok(top.some((t) => t.includes("трек")) && top.some((t) => t.includes("карточка")), top.join("|"));
  assert.ok(!top.some((t) => t.includes("карточка+трек")), "в корне настроек пункта карточка+трек нет");
  assert.ok(dialog.getWindow("s_track") && dialog.getWindow("s_card"));
  assert.throws(() => dialog.getWindow("s_rich"));
  const track = await labelsOf(buttonsOf(dialog.getWindow("s_track").keyboard), { s: base });
  assert.ok(["качество", "подпись и кнопки", "способ отправки"].every((l) => track.some((t) => t.includes(l))));
  const card = await labelsOf(buttonsOf(dialog.getWindow("s_card").keyboard), { s: base });
  assert.ok(
    card.some((t) => t.includes("карточка+трек: выкл")),
    card.join("|"),
  );
  const cardOn = await labelsOf(buttonsOf(dialog.getWindow("s_card").keyboard), {
    s: { ...base, rich_messages: true },
  });
  assert.ok(cardOn.some((t) => t.includes("карточка+трек: вкл")));
});

test("тумблер карточка+трек: переключает значение, сбрасывает кэш, ре-рендер", async () => {
  for (const [start, expected] of [
    [false, true],
    [true, false],
  ] as const) {
    const { container, calls, invalidated } = fakeContainer();
    (container as unknown as { getUserSettings: unknown }).getUserSettings = async () => ({
      ...base,
      rich_messages: start,
    });
    let shown = 0;
    const ctx = { from: { id: 9 }, answerCallbackQuery: async () => {}, show: async () => void shown++ };
    await richToggleOnClick(container)(ctx as never);
    assert.deepEqual(calls, [[9, expected]]);
    assert.deepEqual(invalidated, [9]);
    assert.equal(shown, 1);
  }
});
