/** Диалоговое меню на @gramio/dialogs — единый `menu`-диалог (меню, настройки,
 * help, login/logout). Движок владеет одним сообщением на стек: сам шлёт/редактит
 * и роутит codec-callback_data + ведёт stack-навигацию.
 *
 * Настройки — stateless `Select` (источник истины — Postgres `settingsDb`): getter
 * читает текущее значение, onClick пишет в БД + `show()` (ре-рендер с пометкой ✓).
 * Иконки кнопок — кастом-эмодзи (iconFor) с фолбэком на монохромный глиф. */
import {
  Button,
  type ClickCtx,
  Dialog,
  type DialogManager,
  Group,
  type Keyboard,
  type OnClick,
  Select,
  ShowMode,
  SwitchTo,
  Url,
  Window,
} from "@gramio/dialogs";
import type { Bot } from "gramio";
import { bold, code, type FormattableString, format, italic } from "gramio";
import { getLogger } from "../infra/logging.ts";
import { botMention } from "../infra/text.ts";
import type { DeviceAuthState } from "../services/auth.ts";
import { CARD_ASPECTS, CARD_TOGGLES, type CardToggleName, type UserSettings } from "../storage/settings.ts";
import type { Container } from "./container.ts";
import { helpText, renderNowPlaying, sendCurrentTrack, startText, type TgUser } from "./handlers/common.ts";
import { iconFor } from "./iconSet.ts";
import { safeAnswerCb } from "./safeApi.ts";

const log = getLogger("bot.dialogs");

const TRACK_LAYOUT_LABELS: Record<string, string> = { button: "кнопка", text: "текст", both: "всё", none: "ничего" };
const TRACK_SEND_MODE_LABELS: Record<string, string> = { stub: "пустышка", text_media: "текст → медиа" };
const TRACK_QUALITY_LABELS: Record<string, string> = {
  best: "оптимальное",
  economy: "экономичное",
  lossless: "превосходное",
};
const CARD_PROGRESS_LABELS: Record<string, string> = { wavy: "волна", bar: "полоска" };
const CARD_FIELD_LABELS: Record<string, string> = {
  album: "альбом",
  type: "тип релиза",
  year: "год",
  label: "лейбл",
  track_no: "номер трека",
  avatar: "аватарка",
};
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
const richLabel = (v: string): string => (v === "on" ? "вкл" : "выкл");
const richCurrent = (s: UserSettings): string => (s.rich_messages ? "on" : "off");
const richSave = async (c: Container, userId: number, v: string): Promise<string> =>
  (await c.settingsDb.setRichMessages(userId, v === "on")) ? "on" : "off";
const settingsMainText = (s: UserSettings): FormattableString => format`${bold("⚙️ настройки")}

${bold("🎧 трек")}
качество: ${bold(trackQualityLabel(s.track_quality))}
подпись и кнопки: ${bold(trackLayoutLabel(s.track_layout))}
способ отправки: ${bold(trackSendModeLabel(s.track_send_mode))}

${bold("🖼 карточка")}
прогресс: ${bold(cardProgressLabel(s.card_progress))}
соотношение: ${bold(cardAspectLabel(s.card_aspect))}
подпись и кнопки: ${bold(cardLayoutLabel(s.card_layout))}
поля: ${italic(toggleSummary(s.card_toggles))}
карточка+трек: ${bold(richLabel(richCurrent(s)))}`;
const trackRootText = (s: UserSettings): FormattableString => format`${bold("🎧 трек")}

качество: ${bold(trackQualityLabel(s.track_quality))}
подпись и кнопки: ${bold(trackLayoutLabel(s.track_layout))}
способ отправки: ${bold(trackSendModeLabel(s.track_send_mode))}`;
const layoutPickText = (): FormattableString => format`${bold("подпись и кнопки трека")}

${bold("кнопка")} — под аудио кнопка «открыть»
${bold("текст")} — подпись со ссылкой «открыть»
${bold("всё")} — и подпись, и кнопка
${bold("ничего")} — только аудиофайл`;
const sendModePickText = (): FormattableString => format`${bold("способ отправки (в inline)")}

${bold("пустышка")} — сразу аудиофайл, который подменяется на трек
${bold("текст → медиа")} — сначала «гружу артист — название», потом это сообщение становится треком`;
const qualityPickText = (): FormattableString => format`${bold("качество звука")}

${bold("оптимальное")} — mp3 до 320 кбит/с
${bold("экономичное")} — до 192 кбит/с, легче и быстрее
${bold("превосходное")} — flac без потерь, файлы тяжёлые`;
const cardRootText = (s: UserSettings): FormattableString => format`${bold("🖼 карточка")}

поля: ${italic(toggleSummary(s.card_toggles))}
прогресс: ${bold(cardProgressLabel(s.card_progress))}
соотношение: ${bold(cardAspectLabel(s.card_aspect))}
подпись и кнопки: ${bold(cardLayoutLabel(s.card_layout))}

${bold("карточка+трек")}: ${bold(richLabel(richCurrent(s)))}
${italic("карточка и трек приходят одним сообщением; если не выйдет — пришлю двумя")}`;

const cardAspectPickText = (): FormattableString => format`${bold("соотношение сторон")}

${bold("16:9")} — широкоэкранный (по умолчанию)
${bold("9:16")} — вертикальный`;

const cardLayoutPickText = (): FormattableString => format`${bold("подпись и кнопки карточки")}

${bold("кнопка")} — под фото кнопки «слушать в лс» / «в плеере»
${bold("текст")} — подпись со ссылкой «в плеере»
${bold("всё")} — и подпись, и кнопки
${bold("ничего")} — только фото`;
const cardFieldsText = (t: Record<string, boolean>): FormattableString =>
  format`${bold("поля карточки")}\n\n${italic(toggleSummary(t))}`;
const cardProgressText = (): FormattableString => format`${bold("прогресс трека")}

${bold("волна")} — волнистый
${bold("полоска")} — прямая`;

/** onClick stateless Select: сохранить в БД, сбросить кэш настроек юзера, ре-рендер. */
const radioOnClick =
  (container: Container, label: (v: string) => string, save: (userId: number, v: string) => Promise<string>) =>
  async (ctx: ClickCtx, id: string): Promise<void> => {
    const applied = await save(ctx.from.id, id);
    container.invalidateUserSettings(ctx.from.id);
    await safeAnswerCb(ctx, `ок: ${label(applied)}`);
    await ctx.show();
  };

/** тумблер «карточка+трек»: инвертирует текущее значение, сохраняет, ре-рендер. */
const richToggleOnClick =
  (container: Container): OnClick =>
  async (ctx) => {
    const s = await container.getUserSettings(ctx.from.id);
    const applied = await richSave(container, ctx.from.id, richCurrent(s) === "on" ? "off" : "on");
    container.invalidateUserSettings(ctx.from.id);
    await safeAnswerCb(ctx, `карточка+трек: ${richLabel(applied)}`);
    await ctx.show();
  };

export { radioOnClick, richCurrent, richLabel, richSave, richToggleOnClick, settingsMainText };

type BtnStyle = "danger" | "primary" | "success";

/** текст кнопки: чистая кастом-иконка вместо глифа, если набор покрывает эмодзи;
 * иначе монохромный глиф + лейбл (тот же фолбэк, что dmText в markup.ts). */
function chrome(
  emoji: string,
  glyph: string,
  label: string,
  style?: BtnStyle,
): { text: string; icon?: string; style?: BtnStyle } {
  const id = iconFor(emoji);
  const out: { text: string; icon?: string; style?: BtnStyle } = id
    ? { text: label, icon: id }
    : { text: `${glyph} ${label}` };
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
type LoginData = {
  login?: LoginInfo;
  loginMsg?: string;
  failReason?: string;
  logoutMsg?: string;
  alreadyIn?: boolean;
};

const ALREADY_IN = "✅ ты уже вошёл\n\nсменить аккаунт — кнопка ниже или /logout";
const loginOk = (botUsername: string | null): string =>
  `✅ готово, ты в аккаунте\n\nтеперь пиши ${botMention(botUsername)} название в любом чате или жми кнопки ниже`;

const toLoginInfo = (st: DeviceAuthState): LoginInfo => ({
  userCode: st.userCode,
  verificationUrl: st.verificationUrl,
  mins: Math.floor(st.expiresIn / 60),
});

const deviceFlowText = (l: LoginInfo): FormattableString => format`🔐 ${bold("вход в аккаунт")}

1. жми «продолжить»
2. введи код: ${code(l.userCode)}
3. подтверди вход

код живёт ${l.mins} мин

${italic("пароль остаётся у сервиса — ко мне приходит только токен на музыкальный api. в базе он лежит зашифрованным")}`;

/** Device-flow: проверки → старт → окно `login`. Async-колбэки успеха/провала
 * правят сообщение диалога ИЗВНЕ хендлера через background(bot, stackKey) —
 * stackKey совпадает с дефолтным getStackKey движка (`grd:<userId>`). */
// из команды /login (message-апдейт) Auto-режим шлёт НОВОЕ сообщение, а `main` уже отрисован
// start()-ом — получались два сообщения. Edit правит то, что только что отправил start().
const EDIT_CURRENT = ShowMode.Edit;

export async function startLogin(dialog: DialogManager, bot: Bot, container: Container, userId: number): Promise<void> {
  if (await container.usersDb.getToken(userId)) {
    await dialog.switchTo("login_done", { data: { loginMsg: ALREADY_IN, alreadyIn: true }, mode: EDIT_CURRENT });
    return;
  }
  const pending = container.authService.isPending(userId) ? container.authService.getState(userId) : null;
  if (pending) {
    await dialog.switchTo("login", { data: { login: toLoginInfo(pending) }, mode: EDIT_CURRENT });
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
    await finishLogin(uid, "login_done", { loginMsg: loginOk(container.botUsername) });
  };
  const onFailure = (uid: number, reason: string): Promise<void> =>
    finishLogin(uid, "login_fail", { failReason: reason });
  const state = await container.authService.startDeviceAuth(userId, onSuccess, onFailure);
  if (!state) {
    await dialog.switchTo("login_fail", {
      data: { failReason: "не удалось запустить вход — попробуй позже" },
      mode: EDIT_CURRENT,
    });
    return;
  }
  await dialog.switchTo("login", { data: { login: toLoginInfo(state) }, mode: EDIT_CURRENT });
}

export async function startLogout(dialog: DialogManager, container: Container, userId: number): Promise<void> {
  container.authService.cancelAuth(userId); // незавершённый device-flow не должен залогинить после выхода
  const deleted = await container.usersDb.delete(userId);
  // иначе закэшированный YandexClient/SearchService переживает logout — держит
  // расшифрованный токен и историю юзера в памяти до истечения TTL кэша
  container.invalidateTokenCacheForUser(userId);
  container.albumService.forgetUser(userId);
  await dialog.switchTo("logout_done", {
    data: {
      logoutMsg: deleted ? "вышел из аккаунта ✅\nкогда понадобится — жми кнопку" : "ты пока не входил в аккаунт",
    },
    mode: EDIT_CURRENT,
  });
}

const loggedIn = (rc: { data: unknown }): boolean => Boolean((rc.data as MenuData).loggedIn);
const loggedOut = (rc: { data: unknown }): boolean => !loggedIn(rc);
const cur = (rc: { data: unknown }): UserSettings => (rc.data as SettingsData).s;

export function buildMenuDialog(bot: Bot, container: Container): Dialog {
  const isLoggedIn = async (userId: number): Promise<boolean> => Boolean(await container.usersDb.getToken(userId));

  // действия шлют новые сообщения, меню-сообщение не трогают
  const dmAction =
    (
      label: string,
      action: (
        bot: Bot,
        chatId: number,
        user: TgUser,
        container: Container,
        statusMsgId: number | null,
      ) => Promise<void>,
    ): OnClick =>
    async (ctx) => {
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
  // «сменить аккаунт» из окна «уже вошёл»: выйти и сразу начать вход
  const onSwitchAccount: OnClick = async (ctx) => {
    await safeAnswerCb(ctx);
    const userId = ctx.from.id;
    container.authService.cancelAuth(userId);
    await container.usersDb.delete(userId);
    container.invalidateTokenCacheForUser(userId);
    container.albumService.forgetUser(userId);
    await startLogin(ctx.dialog, bot, container, userId);
  };
  const onCancelLogin: OnClick = async (ctx) => {
    container.authService.cancelAuth(ctx.from.id);
    await safeAnswerCb(ctx, "вход отменён");
    await ctx.dialog.switchTo("main");
  };

  // карточка+трек — один тумблер прямо в разделе «карточка», без отдельного окна
  const onRichToggle: OnClick = richToggleOnClick(container);

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
      onClick: radioOnClick(container, opts.label, opts.save),
    });

  const fieldsSelect = (): Keyboard =>
    Select<string>({
      id: "card_fields",
      items: () => [...CARD_TOGGLES],
      itemId: (v) => v,
      text: (st) => `${cardFieldLabel(st.item)} — ${cur(st).card_toggles[st.item as CardToggleName] ? "вкл" : "выкл"}`,
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
    Group([Group(loggedInBtns, { width: 2, when: loggedIn }), Group(loggedOutBtns, { width: 1, when: loggedOut })]);

  const main = new Window<MenuData>({
    state: "main",
    getter: async (ctx) => ({ loggedIn: await isLoggedIn(uidOf(ctx)) }),
    text: (d) => startText(d.loggedIn, container.botUsername),
    disableWebPreview: true,
    keyboard: Group([
      Group(
        [
          actBtn("🎶", "♪", "что играет", "current", onCurrent),
          actBtn("🖼", "◫", "карточка", "card", onCard),
          navBtn("⚙️", "⚙", "настройки", "settings"),
          navBtn("❓", "?", "что умею", "help"),
        ],
        { width: 2, when: loggedIn },
      ),
      Group([actBtn("🚪", "⏏", "выйти", "logout", onLogout, "danger")], { width: 1, when: loggedIn }),
      Group([actBtn("🔓", "⏻", "войти", "login", onLogin, "success"), navBtn("❓", "?", "что умею", "help")], {
        width: 1,
        when: loggedOut,
      }),
    ]),
  });

  const help = new Window<MenuData>({
    state: "help",
    getter: async (ctx) => ({ loggedIn: await isLoggedIn(uidOf(ctx)) }),
    text: () => helpText(container.botUsername),
    disableWebPreview: true,
    keyboard: authGated(
      [
        actBtn("🎶", "♪", "что играет", "current", onCurrent),
        actBtn("🖼", "◫", "карточка", "card", onCard),
        navBtn("🏠", "⌂", "в меню", "main", "primary"),
      ],
      [actBtn("🔓", "⏻", "войти", "login", onLogin, "success"), navBtn("🏠", "⌂", "в меню", "main", "primary")],
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
      Group([navBtn("🎧", "♪", "трек", "s_track"), navBtn("🖼", "◫", "карточка", "s_card")], { width: 2 }),
      navBtn("🏠", "⌂", "в меню", "main", "primary"),
    ]),
  });

  const sTrack = new Window<SettingsData>({
    state: "s_track",
    getter: settingsGetter,
    text: (d) => trackRootText(d.s),
    keyboard: Group(
      [
        navBtn("🎛", "☰", "качество", "s_quality"),
        navBtn("🗂", "✉", "подпись и кнопки", "s_layout"),
        navBtn("📤", "↥", "способ отправки", "s_sendmode"),
        back("settings"),
      ],
      { width: 1 },
    ),
  });

  const sLayout = new Window<SettingsData>({
    state: "s_layout",
    getter: settingsGetter,
    text: () => layoutPickText(),
    keyboard: Group(
      [
        radioSelect({
          id: "track_layout",
          values: ["button", "text", "both", "none"],
          label: trackLayoutLabel,
          current: (s) => s.track_layout,
          save: (u, v) => container.settingsDb.setTrackLayout(u, v),
        }),
        back("s_track"),
      ],
      { width: 1 },
    ),
  });

  const sSendMode = new Window<SettingsData>({
    state: "s_sendmode",
    getter: settingsGetter,
    text: () => sendModePickText(),
    keyboard: Group(
      [
        radioSelect({
          id: "track_send_mode",
          values: ["stub", "text_media"],
          label: trackSendModeLabel,
          current: (s) => s.track_send_mode,
          save: (u, v) => container.settingsDb.setTrackSendMode(u, v),
        }),
        back("s_track"),
      ],
      { width: 1 },
    ),
  });

  const sQuality = new Window<SettingsData>({
    state: "s_quality",
    getter: settingsGetter,
    text: () => qualityPickText(),
    keyboard: Group(
      [
        radioSelect({
          id: "track_quality",
          values: ["best", "economy", "lossless"],
          label: trackQualityLabel,
          current: (s) => s.track_quality,
          save: (u, v) => container.settingsDb.setTrackQuality(u, v),
        }),
        back("s_track"),
      ],
      { width: 1 },
    ),
  });

  const richIcon = iconFor("📨"); // 🧩 уже у «подпись и кнопки»
  const sCard = new Window<SettingsData>({
    state: "s_card",
    getter: settingsGetter,
    text: (d) => cardRootText(d.s),
    keyboard: Group([
      Group([navBtn("📝", "▤", "поля", "s_card_fields"), navBtn("📊", "∿", "прогресс", "s_card_progress")], {
        width: 2,
      }),
      Group(
        [navBtn("📐", "⬚", "соотношение", "s_card_aspect"), navBtn("🧩", "▦", "подпись и кнопки", "s_card_layout")],
        {
          width: 2,
        },
      ),
      Button({
        text: (d) => {
          const label = `карточка+трек: ${richLabel(richCurrent(cur({ data: d })))}`;
          return richIcon ? label : `◧ ${label}`;
        },
        ...(richIcon ? { icon: richIcon } : {}),
        id: "rich_toggle",
        onClick: onRichToggle,
      }),
      back("settings"),
    ]),
  });

  const sCardLayout = new Window<SettingsData>({
    state: "s_card_layout",
    getter: settingsGetter,
    text: () => cardLayoutPickText(),
    keyboard: Group(
      [
        radioSelect({
          id: "card_layout",
          values: ["button", "text", "both", "none"],
          label: cardLayoutLabel,
          current: (s) => s.card_layout,
          save: (u, v) => container.settingsDb.setCardLayout(u, v),
        }),
        back("s_card"),
      ],
      { width: 1 },
    ),
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
    keyboard: Group(
      [
        radioSelect({
          id: "card_progress",
          values: ["wavy", "bar"],
          label: cardProgressLabel,
          current: (s) => s.card_progress,
          save: (u, v) => container.settingsDb.setCardProgress(u, v),
        }),
        back("s_card"),
      ],
      { width: 1 },
    ),
  });

  const sCardAspect = new Window<SettingsData>({
    state: "s_card_aspect",
    getter: settingsGetter,
    text: () => cardAspectPickText(),
    keyboard: Group(
      [
        radioSelect({
          id: "card_aspect",
          values: [...CARD_ASPECTS],
          label: cardAspectLabel,
          current: (s) => s.card_aspect,
          save: (u, v) => container.settingsDb.setCardAspect(u, v),
        }),
        back("s_card"),
      ],
      { width: 1 },
    ),
  });

  // данные окон читаем из d.dialogData (не из ctx.dialog): под background() ctx headless
  const ld = (d: { dialogData?: unknown }): LoginData => (d.dialogData ?? {}) as LoginData;
  const login = new Window({
    state: "login",
    text: (d) => {
      const l = ld(d).login;
      return l ? deviceFlowText(l) : format`⏳ готовлю вход...`;
    },
    keyboard: Group(
      [
        Url({
          ...chrome("➡️", "▸", "продолжить", "success"),
          url: (rc) => ld(rc.data).login?.verificationUrl ?? "https://music.yandex",
        }),
        actBtn("❌", "✕", "отмена", "cancel_login", onCancelLogin, "danger"),
      ],
      { width: 1 },
    ),
  });

  const alreadyIn = (rc: { data: unknown }): boolean => Boolean(ld(rc.data as { dialogData?: unknown }).alreadyIn);
  const notAlreadyIn = (rc: { data: unknown }): boolean => !alreadyIn(rc);
  const loginDone = new Window({
    state: "login_done",
    text: (d) => format`${ld(d).loginMsg ?? "✅ готово"}`,
    keyboard: Group([
      Group(
        [
          actBtn("🔄", "↻", "сменить аккаунт", "switch_account", onSwitchAccount),
          navBtn("🏠", "⌂", "в меню", "main", "primary"),
        ],
        { width: 1, when: alreadyIn },
      ),
      Group(
        [
          Group([actBtn("🎶", "♪", "что играет", "current", onCurrent), actBtn("🖼", "◫", "карточка", "card", onCard)], {
            width: 2,
          }),
          navBtn("🏠", "⌂", "в меню", "main", "primary"),
        ],
        { when: notAlreadyIn },
      ),
    ]),
  });

  const loginFail = new Window({
    state: "login_fail",
    text: (d) => {
      const r = ld(d).failReason;
      const why = r === "timeout" ? "время ожидания вышло" : (r ?? "");
      return format`❌ не получилось войти — попробуй ещё раз${why ? format`\n\n${italic(why)}` : ""}`;
    },
    keyboard: Group(
      [
        actBtn("🔓", "⏻", "попробовать снова", "login", onLogin, "success"),
        navBtn("🏠", "⌂", "в меню", "main", "primary"),
      ],
      { width: 1 },
    ),
  });

  const logoutDone = new Window({
    state: "logout_done",
    text: (d) => format`${ld(d).logoutMsg ?? "вышел из аккаунта ✅"}`,
    keyboard: Group(
      [actBtn("🔓", "⏻", "войти", "login", onLogin, "success"), navBtn("🏠", "⌂", "в меню", "main", "primary")],
      { width: 1 },
    ),
  });

  return new Dialog({
    id: "menu",
    windows: [
      main,
      help,
      settings,
      sTrack,
      sLayout,
      sSendMode,
      sQuality,
      sCard,
      sCardLayout,
      sCardFields,
      sCardProgress,
      sCardAspect,
      login,
      loginDone,
      loginFail,
      logoutDone,
    ],
  });
}
