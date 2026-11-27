/** Механическая проверка единого стиля пользовательских текстов (src/bot/texts.ts).
 *
 * Обходит ВСЕ экспорты texts.ts: строки и объекты — как есть, функции — на образцах
 * аргументов из SAMPLES (новая функция без образца валит тест, чтобы правила
 * покрывали каждый текст). Правила — см. шапку texts.ts. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { format } from "gramio";
import * as T from "../src/bot/texts.ts";
import type { UserSettings } from "../src/storage/settings.ts";

const settings = {
  track_layout: "button",
  track_send_mode: "stub",
  track_quality: "lossless",
  card_style: "default",
  card_layout: "both",
  card_progress: "wavy",
  card_aspect: "16:9",
  card_toggles: { album: true, type: false, year: true, label: false, track_no: false, avatar: true },
  rich_messages: true,
} as UserSettings;
const header = format`📀 артист — альбом`;
const url = "https://music.yandex.ru/album/1";
const kinds = [["not_found"], ["too_long"], ["no_variants"], ["failed"]];

/** образцы аргументов для каждой функции-экспорта (путь → наборы аргументов). */
const SAMPLES: Record<string, unknown[][]> = {
  startText: [[true], [false], [true, "somebot"]],
  helpText: [[], ["somebot"]],
  groupHint: [["somebot"]],
  privateHint: [[null]],
  loginOk: [["somebot"]],
  loginFailed: [[""], [T.LOGIN_TIMEOUT_REASON], [T.LOGIN_START_FAILED], [T.LOGIN_INTERNAL_FAILED]],
  deviceFlowText: [[{ userCode: "ABCD-EFGH", verificationUrl: "https://ya.ru/device", mins: 5 }]],
  tooOften: [[0.2], [7.2]],
  tooOftenButton: [[0.2], [7.2]],
  degradedNote: [[], ["экономичное 256 кбит/с"]],
  ensureErrorText: kinds,
  ensureErrorButton: kinds,
  inlineNotFound: [["песня"], ["очень длинный запрос ".repeat(5)]],
  cbNotYourTrack: [["somebot"]],
  cardCaptionText: [
    ["https://music.yandex.ru/track/1", "артист", "трек"],
    ["https://music.yandex.ru/track/1", "", "трек"],
  ],
  textMediaTitle: [["артист — трек"]],
  textMediaBody: [["артист — трек"]],
  searchTrackCount: [[1], [3], [11]],
  albumResultTitle: [["альбом"]],
  albumResultText: [
    ["артист — альбом", "2020, 11 треков", url],
    ["артист — альбом", "", url],
  ],
  playlistResultTitle: [["плейлист"]],
  playlistResultText: [
    ["плейлист", "3 трека", url],
    ["плейлист", "", url],
  ],
  kbps: [[320]],
  findingRelease: [[T.ALBUM_NOUN], [T.PLAYLIST_NOUN]],
  uploadingTracks: [[header, "3 трека"]],
  albumRetryButton: [["3 трека"]],
  resumeNeedsLogin: [[T.ALBUM_NOUN]],
  resumeGone: [[T.PLAYLIST_NOUN]],
  resumeAlreadyDone: [[T.ALBUM_NOUN]],
  resumeContinue: [[3, 10, 7]],
  uploadCancelled: [[header, 3, 10]],
  nowSendingTrack: [["трек"]],
  nowSendingBatch: [[10]],
  etaLeft: [["1:20"]],
  sendingNow: [["«трек»"]],
  downloadingInParallel: [["3 трека"]],
  trackLayoutLabel: [["text"], ["нет такого"]],
  trackSendModeLabel: [["text_media"], ["нет такого"]],
  trackQualityLabel: [["lossless"], ["нет такого"]],
  cardLayoutLabel: [["none"]],
  cardProgressLabel: [["bar"], ["нет такого"]],
  cardFieldLabel: [["track_no"]],
  cardAspectLabel: [["9:16"]],
  onOffLabel: [[true], [false]],
  richLabel: [["on"], ["off"]],
  toggleSummary: [[settings.card_toggles], [{}]],
  settingsMainText: [[settings]],
  trackRootText: [[settings]],
  layoutPickText: [[]],
  sendModePickText: [[]],
  qualityPickText: [[]],
  cardRootText: [[settings]],
  cardAspectPickText: [[]],
  cardLayoutPickText: [[]],
  cardFieldsText: [[settings.card_toggles]],
  cardProgressText: [[]],
  savedToast: [["кнопка"]],
  richToggleText: [["вкл"]],
  fieldToggleText: [["альбом", true]],
  fieldToggleToast: [["год", false]],
  "ADMIN.broadcastConfirm": [[5]],
};

interface Rendered {
  path: string;
  text: string;
}

function isFormattable(v: unknown): v is { toString(): string } {
  return typeof v === "object" && v !== null && "entities" in v && "text" in v;
}

function collect(path: string, v: unknown, out: Rendered[]): void {
  if (typeof v === "string") out.push({ path, text: v });
  else if (isFormattable(v)) out.push({ path, text: v.toString() });
  else if (typeof v === "function") {
    const samples = SAMPLES[path];
    assert.ok(samples, `${path}: нет образца аргументов в SAMPLES — добавь, чтобы текст проверялся`);
    for (const args of samples)
      collect(`${path}(${JSON.stringify(args).slice(1, -1)})`, (v as (...a: unknown[]) => unknown)(...args), out);
  } else if (v === null || v === undefined) out.push({ path, text: "" });
  else if (typeof v === "object") {
    for (const [k, x] of Object.entries(v)) collect(`${path}.${k}`, x, out);
  }
}

const ALL: Rendered[] = [];
for (const [name, value] of Object.entries(T)) collect(name, value, ALL);

const EMOJI = /\p{Extended_Pictographic}/u;
const LEADING_EMOJI = /^\p{Extended_Pictographic}(?:\uFE0F|\u200D|\p{Extended_Pictographic})*(\s|$)/u;
/** строки, которым можно начинаться с заглавной (имена собственные). */
const CAPITAL_OK = new Set<string>([T.ADMIN.ymTitle]);

const lines = (r: Rendered): string[] => r.text.split("\n").filter((l) => l.trim() !== "");

test("тексты: обход нашёл все экспорты и не пуст", () => {
  assert.ok(ALL.length > 150, `текстов найдено ${ALL.length}`);
  for (const r of ALL) {
    if (r.path === 'ensureErrorButton("failed")') continue; // null → кнопка «загрузить снова»
    assert.notEqual(r.text.trim(), "", `${r.path}: пустой текст`);
  }
});

test("тексты: многоточие только символом «…», «...» запрещено", () => {
  for (const r of ALL) assert.ok(!r.text.includes("..."), `${r.path}: «...» → «…»: ${JSON.stringify(r.text)}`);
});

test("тексты: без точки в конце строки", () => {
  for (const r of ALL) {
    for (const l of lines(r)) {
      assert.ok(!/[^.]\.$/.test(l.trimEnd()), `${r.path}: точка в конце: ${JSON.stringify(l)}`);
    }
  }
});

test("тексты: строчная буква в начале строки (кроме имён собственных)", () => {
  for (const r of ALL) {
    if (CAPITAL_OK.has(r.text)) continue;
    for (const l of lines(r)) {
      const first = l.match(/\p{L}/u)?.[0];
      if (!first) continue;
      assert.equal(first, first.toLowerCase(), `${r.path}: заглавная в начале: ${JSON.stringify(l)}`);
    }
  }
});

test("тексты: эмодзи — не больше одного и только в начале строки", () => {
  for (const r of ALL) {
    for (const l of lines(r)) {
      const rest = l.replace(LEADING_EMOJI, "");
      assert.ok(!EMOJI.test(rest), `${r.path}: эмодзи не в начале или их несколько: ${JSON.stringify(l)}`);
    }
  }
});

test("тексты: тосты, кнопки меню и кнопки-статусы inline — без эмодзи (кроме «❤️ лайкнул»)", () => {
  const plain = ALL.filter((r) => /^(BTN_|CB_|TOAST_|MENU_BTN\.|tooOftenButton|ensureErrorButton)/.test(r.path));
  assert.ok(plain.length > 20);
  for (const r of plain) {
    if (r.path === "CB_LIKED") continue;
    assert.ok(!EMOJI.test(r.text), `${r.path}: эмодзи в тосте/кнопке: ${JSON.stringify(r.text)}`);
  }
  assert.ok(!EMOJI.test(T.CARD_RESULT.label + T.RICH_RESULT.label + T.LYRICS_RESULT.label));
});

test("тексты: одна формулировка на ситуацию", () => {
  // вход
  for (const r of ALL) {
    if (r.text.includes("сначала войди")) assert.equal(r.text, T.LOGIN_FIRST, `${r.path}: вход — только LOGIN_FIRST`);
  }
  // лимит: «⏳ слишком часто — подожди N сек», N = max(1, ceil)
  assert.equal(T.tooOften(7.2), "⏳ слишком часто — подожди 8 сек");
  assert.equal(T.tooOften(0.1), "⏳ слишком часто — подожди 1 сек");
  assert.equal(T.tooOften(3), `⏳ ${T.tooOftenButton(3)}`);
  for (const r of ALL) {
    if (r.text.includes("слишком часто")) assert.match(r.text, /^(⏳ )?слишком часто — подожди \d+ сек$/, r.path);
  }
  // ошибка
  assert.equal(T.ERROR_RETRY, `❌ ${T.CB_FAILED}`);
  for (const r of ALL) {
    assert.ok(!/ошибка|не получилось|не удалось/.test(r.text), `${r.path}: ошибка — «не вышло…»: ${r.text}`);
  }
  // деградация качества
  assert.equal(T.DEGRADED_NOTE, "⚠️ превосходное недоступно — отдаю оптимальное");
  // процесс скачивания — «качаю», без «гружу/загружаю/заливаю»
  for (const r of ALL) assert.ok(!/гружу|загружа|залива|залит/.test(r.text), `${r.path}: «${r.text}»`);
});

test("тексты: вход везде с 🔐, 🔓 в исходниках нет", () => {
  assert.ok(T.LOGIN_INLINE_BUTTON.startsWith(`${T.LOGIN_EMOJI} `));
  assert.ok(T.deviceFlowText({ userCode: "A", verificationUrl: "u", mins: 1 }).toString().startsWith(T.LOGIN_EMOJI));
  for (const f of srcFiles()) assert.ok(!readFileSync(f, "utf8").includes("🔓"), `${f}: 🔓 → LOGIN_EMOJI`);
});

test("тексты: нет захардкоженного @nowymbot (только дефолт botMention)", () => {
  for (const f of srcFiles()) {
    if (f.replaceAll("\\", "/").endsWith("infra/text.ts")) continue;
    const code = readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    assert.ok(!code.includes("@nowymbot"), `${f}: @nowymbot → botMention(container.botUsername)`);
  }
  assert.match(T.startText(true, "otherbot").toString(), /@otherbot/);
  assert.ok(!T.startText(true, "otherbot").toString().includes("nowymbot"));
});

test("тексты: число треков склоняется (1 трек / 2 трека / 5 треков)", () => {
  assert.equal(T.searchTrackCount(1), "1 трек");
  assert.equal(T.searchTrackCount(2), "2 трека");
  assert.equal(T.searchTrackCount(5), "5 треков");
  assert.equal(T.searchTrackCount(21), "21 трек");
  assert.equal(T.searchTrackCount(12), "12 треков");
});

test("тексты: /help не обещает поиск альбомов по названию и не выдаёт кнопку за команду", () => {
  const help = T.helpText().toString();
  assert.ok(!help.includes("поиск треков и альбомов"));
  assert.ok(help.includes(`кнопка «${T.MENU_BTN.current}» в меню`));
});

test("тексты: эффекты по-русски в /help и в названии трека", () => {
  const help = T.helpText().toString();
  for (const k of ["ncore", "speed", "slow"] as const) {
    assert.ok(help.includes(T.EFFECT_NAMES[k]), `в /help нет «${T.EFFECT_NAMES[k]}»`);
    assert.equal(T.EFFECT_SUFFIX[k], `(${T.EFFECT_NAMES[k]})`);
    assert.ok(!/[a-z]/i.test(T.EFFECT_NAMES[k]), `${k}: латиница в названии эффекта`);
  }
});

function srcFiles(dir = join(import.meta.dirname, "..", "src")): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}
