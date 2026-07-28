/** Диалоговое меню на @gramio/dialogs — единый `menu`-диалог (меню, настройки,
 * help, login/logout). Движок владеет одним сообщением на стек: сам шлёт/редактит
 * и роутит codec-callback_data + ведёт stack-навигацию.
 *
 * Настройки — stateless `Select` (источник истины — Postgres `settingsDb`): getter
 * читает текущее значение, onClick пишет в БД + `show()` (ре-рендер с пометкой ✓).
 * Иконки кнопок — кастом-эмодзи (iconFor) с фолбэком на монохромный глиф. */
import { Button, Dialog, Group, Select, SwitchTo, Url, Window, type ClickCtx, type DialogManager, type Keyboard, type OnClick } from "@gramio/dialogs";
import { type FormattableString, bold, code, format, italic } from "gramio";
import type { Bot } from "gramio";
import { getLogger } from "../infra/logging.ts";
import type { Container } from "./container.ts";
import { iconFor } from "./iconSet.ts";
import { safeAnswerCb } from "./safeApi.ts";
import { helpText, renderNowPlaying, sendCurrentTrack, startText, type TgUser } from "./handlers/common.ts";
import type { DeviceAuthState } from "../services/auth.ts";
import { CARD_TOGGLES, CARD_ASPECTS, type CardToggleName, type UserSettings } from "../storage/settings.ts";

const log = getLogger("bot.dialogs");

const TRACK_LAYOUT_LABELS: Record<string, string> = { button: "кнопка", text: "текст", both: "всё", none: "ничего" };
const TRACK_SEND_MODE_LABELS: Record<string, string> = { stub: "пустышка", text_media: "текст → медиа" };
const TRACK_QUALITY_LABELS: Record<string, string> = { best: "оптимальное", economy: "экономичное", lossless: "превосходное" };
const CARD_PROGRESS_LABELS: Record<string, string> = { wavy: "волна", bar: "полоска" };
const CARD_FIELD_LABELS: Record<string, string> = { album: "альбом", type: "тип релиза", year: "год", label: "лейбл", track_no: "номер трека", avatar: "аватарка" };
const CARD_ASPECT_LABELS: Record<string, string> = { "16:9": "16:9", "9:16": "9:16" };
const trackLayoutLabel = (v: string): string => TRACK_LAYOUT_LABELS[v] ?? TRACK_LAYOUT_LABELS.button!;
const trackSendModeLabel = (v: string): string => TRACK_SEND_MODE_LABELS[v] ?? TRACK_SEND_MODE_LABELS.stub!;
const trackQualityLabel = (v: string): string => TRACK_QUALITY_LABELS[v] ?? TRACK_QUALITY_LABELS.best!;
const cardLayoutLabel = trackLayoutLabel;
const cardProgressLabel = (v: string): string => CARD_PROGRESS_LABELS[v] ?? CARD_PROGRESS_LABELS.wavy!;
const cardFieldLabel = (v: string): string => CARD_FIELD_LABELS[v] ?? v;
const cardAspectLabel = (v: string): string => CARD_ASPECT_LABELS[v] ?? v;

const toggleSummary = (t: Record<string, boolean>): string => {
  const on = CARD_TOGGLES.filter((n) => t[n]).map(cardFieldLabel);
  return on.length > 0 ? on.join(", ") : "ничего не выбрано";
};
const settingsMainText = (s: UserSettings): FormattableString => format`${bold("настройки")}

как слать трек: ${bold(trackLayoutLabel(s.track_layout))}
тип отправки: ${bold(trackSendModeLabel(s.track_send_mode))}
качество: ${bold(trackQualityLabel(s.track_quality))}
карточка: ${bold(cardLayoutLabel(s.card_layout))}, ${bold(cardProgressLabel(s.card_progress))}, ${italic(toggleSummary(s.card_toggles))}`;
const layoutPickText = (): FormattableString => format`${bold("как слать трек")}

${bold("кнопка")} — под аудио кнопка «открыть»
${bold("текст")} — подпись со ссылкой «открыть»
${bold("всё")} — и подпись, и кнопка
${bold("ничего")} — только аудиофайл`;
const sendModePickText = (): FormattableString => format`${bold("тип отправки")}

${bold("пустышка")} — сразу аудиофайл, который подменяется на трек
${bold("текст → медиа")} — сначала текст «гружу артист — название», потом он превращается в аудио`;
const qualityPickText = (): FormattableString => format`${bold("качество звука")}

${bold("оптимальное")} — mp3 до 320
${bold("экономичное")} — до 192 kbps, легче и быстрее
${bold("превосходное")} — FLAC, лосслесс, тяжёлый`;
const cardRootText = (s: UserSettings): FormattableString => format`${bold("карточка")}

поля: ${italic(toggleSummary(s.card_toggles))}
прогресс: ${bold(cardProgressLabel(s.card_progress))}
формат: ${bold(cardLayoutLabel(s.card_layout))}
соотношение: ${bold(cardAspectLabel(s.card_aspect))}`;

const cardAspectPickText = (): FormattableString => format`${bold("соотношение сторон")}

${bold("16:9")} — широкоэкранный (по умолчанию)
${bold("9:16")} — вертикальный`;

const cardLayoutPickText = (): FormattableString => format`${bold("формат карточки")}

${bold("кнопка")} — под фото кнопки «слушать в лс» / «в плеере»
${bold("текст")} — подпись со ссылкой «в плеере»
${bold("всё")} — и подпись, и кнопки
${bold("ничего")} — только фото`;
const cardFieldsText = (t: Record<string, boolean>): FormattableString => format`${bold("поля карточки")}\n\n${italic(toggleSummary(t))}`;
const cardProgressText = (): FormattableString => format`${bold("прогресс трека")}

${bold("волна")} — волнистый
${bold("полоска")} — прямая`;

type BtnStyle = "danger" | "primary" | "success";

/** текст кнопки: чистая кастом-иконка вместо глифа, если набор покрывает эмодзи;
 * иначе монохромный глиф + лейбл (тот же фолбэк, что dmText в markup.ts). */
function chrome(emoji: string, glyph: string, label: string, style?: BtnStyle): { text: string; icon?: string; style?: BtnStyle } {
  const id = iconFor(emoji);
  const out: { text: string; icon?: string; style?: BtnStyle } = id ? { text: label, icon: id } : { text: `${glyph} ${label}` };
  if (style) out.style = style;
  return out;
}

function actBtn(emoji: string, glyph: string, label: string, id: string, onClick: OnClick, style?: BtnStyle): Keyboard {
  return Button({ ...chrome(emoji, glyph, label, style), id, onClick });
}

function navBtn(emoji: string, glyph: string, label: string, state: string, style?: BtnStyle): Keyboard {
  return SwitchTo({ ...chrome(emoji, glyph, label, style), state });
}

function toTgUser(from: { id: number; username?: string; firstName?: string }): TgUser {
  return { id: from.id, username: from.username ?? null, firstName: from.firstName ?? null };
}

/** userId из ctx getter'а; senderId-фолбэк для headless-ctx из background(). */
const uidOf = (ctx: { from?: { id: number }; senderId?: number }): number => ctx.from?.id ?? ctx.senderId ?? 0;

type MenuData = { loggedIn: boolean };
type SettingsData = { s: UserSettings; userId: number };
type LoginInfo = { userCode: string; verificationUrl: string; mins: number };
type LoginData = { login?: LoginInfo; loginMsg?: string; failReason?: string; logoutMsg?: string };

const ALREADY_IN = "✅ ты уже вошёл\n\nчтобы сменить аккаунт — сначала выйди, потом /login";
const LOGIN_OK = "✅ готово, ты в аккаунте\n\nтеперь пиши @nowymbot название в любом чате или жми кнопки ниже";

const toLoginInfo = (st: DeviceAuthState): LoginInfo => ({
  userCode: st.userCode,
  verificationUrl: st.verificationUrl,
  mins: Math.floor(st.expiresIn / 60),
});

const deviceFlowText = (l: LoginInfo): FormattableString => format`🔐 ${bold("вход в аккаунт")}

1. жми кнопку ниже
2. введи код: ${code(l.userCode)}
3. подтверди вход

код живёт ${l.mins} мин

${italic("пароль остаётся у сервиса — ко мне приходит только токен на музыкальный api. в базе он лежит зашифрованным")}`;

/** Device-flow: проверки → старт → окно `login`. Async-колбэки успеха/провала
 * правят сообщение диалога ИЗВНЕ хендлера через background(bot, stackKey) —
 * stackKey совпадает с дефолтным getStackKey движка (`grd:<userId>`). */
export async function startLogin(dialog: DialogManager, bot: Bot, container: Container, userId: number): Promise<void> {
  if (await container.usersDb.getToken(userId)) {
    await dialog.switchTo("login_done", { data: { loginMsg: ALREADY_IN } });
    return;
  }
  const pending = container.authService.isPending(userId) ? container.authService.getState(userId) : null;
  if (pending) {
    await dialog.switchTo("login", { data: { login: toLoginInfo(pending) } });
    return;
  }
  // device-flow рендерит извне хендлера через background(); try/catch — pollLoop detached
  const finishLogin = async (uid: number, state: string, patch: LoginData): Promise<void> => {
    try {
      const mgr = await container.dialogBackground?.(bot, `grd:${uid}`);
      if (!mgr) return;
      await mgr.switchTo(state, { data: patch });
    } catch (e) {
      log.warning(`[login] фоновый рендер «${state}» упал: ${e}`);
    }
  };
  const onSuccess = async (uid: number): Promise<void> => {
    container.invalidateTokenCacheForUser(uid);
    await finishLogin(uid, "login_done", { loginMsg: LOGIN_OK });
  };
  const onFailure = (uid: number, reason: string): Promise<void> =>
    finishLogin(uid, "login_fail", { failReason: reason });
  const state = await container.authService.startDeviceAuth(userId, onSuccess, onFailure);
  if (!state) {
    await dialog.switchTo("login_fail", { data: { failReason: "не удалось запустить вход — попробуй позже" } });
    return;
  }
  await dialog.switchTo("login", { data: { login: toLoginInfo(state) } });
}

export async function startLogout(dialog: DialogManager, container: Container, userId: number): Promise<void> {
  const deleted = await container.usersDb.delete(userId);
  // иначе закэшированный YandexClient/SearchService переживает logout — держит
  // расшифрованный токен и историю юзера в памяти до истечения TTL кэша
  container.invalidateTokenCacheForUser(userId);
  await dialog.switchTo("logout_done", {
    data: { logoutMsg: deleted ? "вышел из аккаунта ✅\nкогда понадобится — жми кнопку" : "ты пока не входил в аккаунт" },
  });
}

const loggedIn = (rc: { data: unknown }): boolean => Boolean((rc.data as MenuData).loggedIn);
const loggedOut = (rc: { data: unknown }): boolean => !loggedIn(rc);
const cur = (rc: { data: unknown }): UserSettings => (rc.data as SettingsData).s;

export function buildMenuDialog(bot: Bot, container: Container): Dialog {
  const isLoggedIn = async (userId: number): Promise<boolean> => Boolean(await container.usersDb.getToken(userId));

  // действия шлют новые сообщения, меню-сообщение не трогают
  const dmAction = (
    label: string,
    action: (bot: Bot, chatId: number, user: TgUser, container: Container, statusMsgId: number | null) => Promise<void>,
  ): OnClick => async (ctx) => {
    const chatId = ctx.message?.chat?.id;
    if (chatId === undefined) {
      await safeAnswerCb(ctx); // закрыть «часики», а не молча выйти
      return;
    }
    await safeAnswerCb(ctx, label);
    await action(bot, chatId, toTgUser(ctx.from), container, null);
  };
  const onCard: OnClick = dmAction("⏳ рисую карточку...", renderNowPlaying);
  const onCurrent: OnClick = dmAction("⏳ ищу что играет...", sendCurrentTrack);
  const onLogin: OnClick = async (ctx) => {
    await safeAnswerCb(ctx);
    await startLogin(ctx.dialog, bot, container, ctx.from.id);
  };
  const onLogout: OnClick = async (ctx) => {
    await safeAnswerCb(ctx);
    await startLogout(ctx.dialog, container, ctx.from.id);
  };
  const onCancelLogin: OnClick = async (ctx) => {
    container.authService.cancelAuth(ctx.from.id);
    await safeAnswerCb(ctx, "вход отменён");
    await ctx.dialog.switchTo("main");
  };

  // stateless Select — источник истины settingsDb (Postgres), не локальный state
  const radioSelect = (opts: {
    id: string;
    values: readonly string[];
    label: (v: string) => string;
    current: (s: UserSettings) => string;
    save: (userId: number, v: string) => Promise<string>;
  }): Keyboard =>
    Select<string>({
      id: opts.id,
      items: () => opts.values as string[],
      itemId: (v) => v,
      // selected → движок сам метит текущий пункт ✓; data — слитый render-бэг
      selected: (data) => opts.current((data as SettingsData).s),
      text: (st) => opts.label(st.item),
      onClick: async (ctx: ClickCtx, id) => {
        const applied = await opts.save(ctx.from.id, id);
        container.invalidateUserSettings(ctx.from.id);
        await safeAnswerCb(ctx, `ок: ${opts.label(applied)}`);
        await ctx.show();
      },
    });

  const fieldsSelect = (): Keyboard =>
    Select<string>({
      id: "card_fields",
      items: () => [...CARD_TOGGLES],
      itemId: (v) => v,
      text: (st) => `${cardFieldLabel(st.item)} — ${cur(st).card_toggles[st.item as CardToggleName] ? "вкл." : "выкл."}`,
      onClick: async (ctx: ClickCtx, id) => {
        const s = await container.getUserSettings(ctx.from.id);
        const next = !s.card_toggles[id as CardToggleName];
        await container.settingsDb.setCardToggle(ctx.from.id, id, next);
        container.invalidateUserSettings(ctx.from.id);
        await safeAnswerCb(ctx, `${cardFieldLabel(id)}: ${next ? "вкл" : "выкл"}`);
        await ctx.show();
      },
    });

  const back = (state: string): Keyboard => navBtn("⬅️", "←", "назад", state);

  // loggedIn-кнопки шириной 2, loggedOut — шириной 1 (везде одна и та же раскладка).
  const authGated = (loggedInBtns: Keyboard[], loggedOutBtns: Keyboard[]): Keyboard =>
    Group([
      Group(loggedInBtns, { width: 2, when: loggedIn }),
      Group(loggedOutBtns, { width: 1, when: loggedOut }),
    ]);

  const main = new Window<MenuData>({
    state: "main",
    getter: async (ctx) => ({ loggedIn: await isLoggedIn(uidOf(ctx)) }),
    text: (d) => startText(d.loggedIn),
    disableWebPreview: true,
    keyboard: authGated(
      [
        actBtn("🎶", "♪", "что играет", "current", onCurrent),
        actBtn("🖼", "◫", "карточка", "card", onCard),
        navBtn("⚙️", "⚙", "настройки", "settings"),
        actBtn("🚪", "⏏", "выйти", "logout", onLogout, "danger"),
        navBtn("❓", "⍰", "что умею", "help"),
      ],
      [
        actBtn("🔓", "⏻", "войти", "login", onLogin, "success"),
        navBtn("❓", "⍰", "что умею", "help"),
      ],
    ),
  });

  const help = new Window<MenuData>({
    state: "help",
    getter: async (ctx) => ({ loggedIn: await isLoggedIn(uidOf(ctx)) }),
    text: () => helpText(),
    disableWebPreview: true,
    keyboard: authGated(
      [
        actBtn("🎶", "♪", "что играет", "current", onCurrent),
        actBtn("🖼", "◫", "карточка", "card", onCard),
        navBtn("🏠", "⌂", "в меню", "main", "primary"),
      ],
      [
        actBtn("🔓", "⏻", "войти", "login", onLogin, "success"),
        navBtn("🏠", "⌂", "в меню", "main", "primary"),
      ],
    ),
  });

  const settingsGetter = async (ctx: { from?: { id: number }; senderId?: number }): Promise<SettingsData> => {
    const userId = uidOf(ctx);
    return { s: await container.getUserSettings(userId), userId };
  };

  const settings = new Window<SettingsData>({
    state: "settings",
    getter: settingsGetter,
    text: (d) => settingsMainText(d.s),
    keyboard: Group([
      navBtn("🗂", "✉", "как слать трек", "s_layout"),
      navBtn("📤", "↥", "тип отправки", "s_sendmode"),
      navBtn("🎛", "☰", "качество", "s_quality"),
      navBtn("🖼", "◫", "карточка", "s_card"),
      navBtn("🏠", "⌂", "в меню", "main", "primary"),
    ], { width: 1 }),
  });

  const sLayout = new Window<SettingsData>({
    state: "s_layout",
    getter: settingsGetter,
    text: () => layoutPickText(),
    keyboard: Group([
      radioSelect({
        id: "track_layout",
        values: ["button", "text", "both", "none"],
        label: trackLayoutLabel,
        current: (s) => s.track_layout,
        save: (u, v) => container.settingsDb.setTrackLayout(u, v),
      }),
      back("settings"),
    ], { width: 1 }),
  });

  const sSendMode = new Window<SettingsData>({
    state: "s_sendmode",
    getter: settingsGetter,
    text: () => sendModePickText(),
    keyboard: Group([
      radioSelect({
        id: "track_send_mode",
        values: ["stub", "text_media"],
        label: trackSendModeLabel,
        current: (s) => s.track_send_mode,
        save: (u, v) => container.settingsDb.setTrackSendMode(u, v),
      }),
      back("settings"),
    ], { width: 1 }),
  });

  const sQuality = new Window<SettingsData>({
    state: "s_quality",
    getter: settingsGetter,
    text: () => qualityPickText(),
    keyboard: Group([
      radioSelect({
        id: "track_quality",
        values: ["best", "economy", "lossless"],
        label: trackQualityLabel,
        current: (s) => s.track_quality,
        save: (u, v) => container.settingsDb.setTrackQuality(u, v),
      }),
      back("settings"),
    ], { width: 1 }),
  });

  const sCard = new Window<SettingsData>({
    state: "s_card",
    getter: settingsGetter,
    text: (d) => cardRootText(d.s),
    keyboard: Group([
      Group([
        navBtn("📝", "▤", "поля", "s_card_fields"),
        navBtn("📊", "∿", "прогресс", "s_card_progress"),
      ], { width: 2 }),
      navBtn("🧩", "▦", "формат", "s_card_layout"),
      navBtn("📐", "⬚", "соотношение", "s_card_aspect"),
      back("settings"),
    ]),
  });

  const sCardLayout = new Window<SettingsData>({
    state: "s_card_layout",
    getter: settingsGetter,
    text: () => cardLayoutPickText(),
    keyboard: Group([
      radioSelect({
        id: "card_layout",
        values: ["button", "text", "both", "none"],
        label: cardLayoutLabel,
        current: (s) => s.card_layout,
        save: (u, v) => container.settingsDb.setCardLayout(u, v),
      }),
      back("s_card"),
    ], { width: 1 }),
  });

  const sCardFields = new Window<SettingsData>({
    state: "s_card_fields",
    getter: settingsGetter,
    text: (d) => cardFieldsText(d.s.card_toggles),
    keyboard: Group([fieldsSelect(), back("s_card")], { width: 1 }),
  });

  const sCardProgress = new Window<SettingsData>({
    state: "s_card_progress",
    getter: settingsGetter,
    text: () => cardProgressText(),
    keyboard: Group([
      radioSelect({
        id: "card_progress",
        values: ["wavy", "bar"],
        label: cardProgressLabel,
        current: (s) => s.card_progress,
        save: (u, v) => container.settingsDb.setCardProgress(u, v),
      }),
      back("s_card"),
    ], { width: 1 }),
  });

  const sCardAspect = new Window<SettingsData>({
    state: "s_card_aspect",
    getter: settingsGetter,
    text: () => cardAspectPickText(),
    keyboard: Group([
      radioSelect({
        id: "card_aspect",
        values: [...CARD_ASPECTS],
        label: cardAspectLabel,
        current: (s) => s.card_aspect,
        save: (u, v) => container.settingsDb.setCardAspect(u, v),
      }),
      back("s_card"),
    ], { width: 1 }),
  });

  // данные окон читаем из d.dialogData (не из ctx.dialog): под background() ctx headless
  const ld = (d: { dialogData?: unknown }): LoginData => (d.dialogData ?? {}) as LoginData;
  const login = new Window({
    state: "login",
    text: (d) => {
      const l = ld(d).login;
      return l ? deviceFlowText(l) : format`⏳ готовлю вход...`;
    },
    keyboard: Group([
      Url({
        ...chrome("➡️", "▸", "продолжить", "success"),
        url: (rc) => ld(rc.data).login?.verificationUrl ?? "https://music.yandex",
      }),
      actBtn("❌", "✕", "отмена", "cancel_login", onCancelLogin, "danger"),
    ], { width: 1 }),
  });

  const loginDone = new Window({
    state: "login_done",
    text: (d) => format`${ld(d).loginMsg ?? "✅ готово"}`,
    keyboard: Group([
      Group([
        actBtn("🎶", "♪", "что играет", "current", onCurrent),
        actBtn("🖼", "◫", "карточка", "card", onCard),
      ], { width: 2 }),
      navBtn("🏠", "⌂", "в меню", "main", "primary"),
    ]),
  });

  const loginFail = new Window({
    state: "login_fail",
    text: (d) => {
      const r = ld(d).failReason;
      return r === "timeout" ? format`⌛ время ожидания вышло — попробуй ещё раз` : format`❌ ошибка входа: ${r ?? ""}`;
    },
    keyboard: Group([navBtn("🏠", "⌂", "в меню", "main", "primary")]),
  });

  const logoutDone = new Window({
    state: "logout_done",
    text: (d) => format`${ld(d).logoutMsg ?? "вышел из аккаунта ✅"}`,
    keyboard: Group([
      actBtn("🔓", "⏻", "войти снова", "login", onLogin, "success"),
      navBtn("🏠", "⌂", "в меню", "main", "primary"),
    ], { width: 1 }),
  });

  return new Dialog({
    id: "menu",
    windows: [
      main, help, settings, sLayout, sSendMode, sQuality, sCard, sCardLayout, sCardFields, sCardProgress,
      sCardAspect,
      login, loginDone, loginFail, logoutDone,
    ],
  });
}
