/** Настройка rich messages (тумблер в разделе «карточка»): тексты, маппинг on/off, сохранение (без сети/БД). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
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
import type { ApiBot as Bot } from "../src/bot/types.ts";
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

test("radioOnClick: сохраняет, инвалидирует кэш юзера, затем ре-рендер (dialog.invalidate)", async () => {
  const { container, calls, invalidated } = fakeContainer();
  const order: string[] = [];
  const ctx = {
    from: { id: 42 },
    answer: async () => order.push("answer"),
    dialog: { invalidate: () => void order.push("show") },
  };
  await radioOnClick(container, richLabel, (u, v) => richSave(container, u, v))(ctx as never, "on");
  assert.deepEqual(calls, [[42, true]]);
  assert.deepEqual(invalidated, [42]);
  assert.equal(order.at(-1), "show");
});

test("тексты: главная строка настроек показывает карточка+трек", () => {
  const on = settingsMainText({ ...base, rich_messages: true }).text;
  const off = settingsMainText(base).text;
  assert.match(on, /карточка \+ трек: вкл/);
  assert.match(off, /карточка \+ трек: выкл/);
});

/** лейблы кнопок окна morda: рендер окна с фейковым ctx (настройки из контейнера). */
async function labelsOf(windowId: string, s: UserSettings): Promise<string[]> {
  const container = { getUserSettings: async () => s } as unknown as Container;
  const def = buildMenuDialog({} as Bot, container);
  const win = def[windowId];
  assert.ok(win, `окно ${windowId} есть`);
  const render = typeof win === "function" ? win : win.render;
  const frame = { window: windowId, params: undefined, data: {}, hooks: [], intent: "i" };
  const view = await render({ from: { id: 1 }, chat: { id: 1 } } as never, frame);
  return (view.keyboard ?? []).flat().map((b) => b.label);
}

test("настройки: два раздела, «карточка+трек» живёт внутри «карточка», окна s_rich нет", async () => {
  const top = await labelsOf("settings", base);
  assert.ok(top.some((t) => t.includes("трек")) && top.some((t) => t.includes("карточка")), top.join("|"));
  assert.ok(!top.some((t) => t.includes("карточка + трек")), "в корне настроек пункта карточка+трек нет");
  const def = buildMenuDialog({} as Bot, {} as Container);
  assert.ok(def.s_track && def.s_card);
  assert.equal(def.s_rich, undefined);
  const track = await labelsOf("s_track", base);
  assert.ok(["качество", "подпись и кнопки", "способ отправки"].every((l) => track.some((t) => t.includes(l))));
  const card = await labelsOf("s_card", base);
  assert.ok(
    card.some((t) => t.includes("карточка + трек: выкл")),
    card.join("|"),
  );
  const cardOn = await labelsOf("s_card", { ...base, rich_messages: true });
  assert.ok(cardOn.some((t) => t.includes("карточка + трек: вкл")));
});

test("радио-окно метит текущее значение « ✓» (как Select.selected у GramIO)", async () => {
  const labels = await labelsOf("s_quality", base);
  const marked = labels.filter((l) => l.endsWith(" ✓"));
  assert.equal(marked.length, 1, labels.join("|"));
  assert.ok(labels.at(-1)!.includes("назад"), "последней — «назад»");
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
    const ctx = { from: { id: 9 }, answer: async () => {}, dialog: { invalidate: () => void shown++ } };
    await richToggleOnClick(container)(ctx as never);
    assert.deepEqual(calls, [[9, expected]]);
    assert.deepEqual(invalidated, [9]);
    assert.equal(shown, 1);
  }
});
