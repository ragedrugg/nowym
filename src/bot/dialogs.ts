/** Диалоговое меню на @yaebal/morda — одно сообщение-меню на чат (меню, настройки,
 * help, login/logout). Движок владеет этим сообщением: сам шлёт/редактит, роутит
 * свои callback_data (`dlg:…`) и ведёт стек окон.
 *
 * Перенос с @gramio/dialogs (поведение для юзера то же):
 *  • Window/Group/Button/SwitchTo/Url/Select → окно = render(ctx, frame) → WindowView;
 *    раскладка Group({ width }) собирается руками (chunk), `when` — обычный if.
 *  • SwitchTo → dialog.replace (смена окна на месте; morda-хелпер switchTo пушит и
 *    упёрся бы в потолок стека на «назад»/«в меню»).
 *  • GramIO перерисовывал окно после каждого обработанного клика — click() делает
 *    invalidate() после onClick; ctx.show() → dialog.invalidate().
 *  • Настройки — stateless-радио (источник истины — Postgres `settingsDb`): render
 *    читает текущее значение и метит пункт « ✓» (как Select.selected у GramIO).
 *  • ResetStack у GramIO оставлял прежнее меню-сообщение (его кнопки — «устарело»),
 *    morda.start() его удаляет → startMenu() сначала сбрасывает сохранённое
 *    состояние, и start() шлёт новое меню, не трогая старое.
 *  • morda сам гасит спиннер пустым answerCallbackQuery ДО events.onStale — тост
 *    «меню устарело» потерялся бы; dialogAnswerGate откладывает это пустое
 *    «гашение» до конца апдейта (см. ниже).
 * Иконки кнопок — кастом-эмодзи (iconFor) с фолбэком на монохромный глиф. */
import {
  type CallbackButton,
  createDialogs,
  type DialogButton,
  type DialogContext,
  type DialogControl,
  type DialogDef,
  type DialogState,
  type WindowView,
} from "@yaebal/morda";
import { type Context, format, type Middleware, type StorageAdapter, type User } from "yaebal";
import { getLogger } from "../infra/logging.ts";
import { incCounter } from "../infra/metrics.ts";
import type { DeviceAuthState } from "../services/auth.ts";
import { CARD_ASPECTS, CARD_TOGGLES, type CardToggleName, type UserSettings } from "../storage/settings.ts";
import type { Container } from "./container.ts";
import { renderNowPlaying, sendCurrentTrack } from "./handlers/common.ts";
import { iconFor } from "./iconSet.ts";
import { retryingApi } from "./mordaRetry.ts";
import { safeAnswerCb } from "./safeApi.ts";
import {
  ALREADY_IN,
  cardAspectLabel,
  cardAspectPickText,
  cardFieldLabel,
  cardFieldsText,
  cardLayoutLabel,
  cardLayoutPickText,
  cardProgressLabel,
  cardProgressText,
  cardRootText,
  deviceFlowText,
  fieldToggleText,
  fieldToggleToast,
  helpText,
  LOGIN_CANCELLED,
  LOGIN_DONE_FALLBACK,
  LOGIN_EMOJI,
  LOGIN_PREPARING,
  LOGIN_START_FAILED,
  LOGIN_TIMEOUT_REASON,
  LOGOUT_DONE,
  LOGOUT_DONE_FALLBACK,
  type LoginInfo,
  layoutPickText,
  loginFailed,
  loginOk,
  MENU_BTN,
  NOT_LOGGED_IN,
  qualityPickText,
  richLabel,
  richToggleText,
  STALE_MENU,
  savedToast,
  sendModePickText,
  settingsMainText,
  startText,
  TOAST_DRAWING_CARD,
  TOAST_FINDING_PLAYING,
  trackLayoutLabel,
  trackQualityLabel,
  trackRootText,
  trackSendModeLabel,
} from "./texts.ts";
import { type ApiBot, type TgUser, tgUserOf } from "./types.ts";

const log = getLogger("bot.dialogs");

/** callback_data-неймспейс morda (дефолт движка). */
export const DIALOG_PREFIX = "dlg";

/** ключ состояния morda (дефолтный getKey): в личке — id чата (= id юзера). */
const stateKey = (chatId: number | string): string => `${DIALOG_PREFIX}:${chatId}`;

type AnswerParams = string | { text?: string; show_alert?: boolean };

/** контекст onClick: callback-апдейт (rich CallbackQueryContext yaebal) + ctx.dialog. */
export type ClickCtx = {
  from: Pick<User, "id" | "username" | "first_name">;
  message?: { chat?: { id: number } };
  dialog: Pick<DialogControl, "invalidate" | "replace" | "setData">;
  answer(params?: AnswerParams): Promise<unknown>;
};
type OnClick = (ctx: ClickCtx) => Promise<void>;

const richCurrent = (s: UserSettings): string => (s.rich_messages ? "on" : "off");
const richSave = async (c: Container, userId: number, v: string): Promise<string> =>
  (await c.settingsDb.setRichMessages(userId, v === "on")) ? "on" : "off";

/** onClick stateless-радио: сохранить в БД, сбросить кэш настроек юзера, ре-рендер. */
const radioOnClick =
  (container: Container, label: (v: string) => string, save: (userId: number, v: string) => Promise<string>) =>
  async (ctx: ClickCtx, id: string): Promise<void> => {
    const applied = await save(ctx.from.id, id);
    container.invalidateUserSettings(ctx.from.id);
    await safeAnswerCb(ctx, savedToast(label(applied)));
    ctx.dialog.invalidate();
  };

/** тумблер «карточка+трек»: инвертирует текущее значение, сохраняет, ре-рендер. */
const richToggleOnClick =
  (container: Container): OnClick =>
  async (ctx) => {
    const s = await container.getUserSettings(ctx.from.id);
    const applied = await richSave(container, ctx.from.id, richCurrent(s) === "on" ? "off" : "on");
    container.invalidateUserSettings(ctx.from.id);
    await safeAnswerCb(ctx, richToggleText(richLabel(applied)));
    ctx.dialog.invalidate();
  };

export { radioOnClick, richCurrent, richLabel, richSave, richToggleOnClick, settingsMainText };

type BtnStyle = "danger" | "primary" | "success";
type Chrome = { label: string; icon?: string; style?: BtnStyle };

/** текст кнопки: чистая кастом-иконка вместо глифа, если набор покрывает эмодзи;
 * иначе монохромный глиф + лейбл (тот же фолбэк, что dmText в markup.ts). */
function chrome(emoji: string, glyph: string, label: string, style?: BtnStyle): Chrome {
  const id = iconFor(emoji);
  const out: Chrome = id ? { label, icon: id } : { label: `${glyph} ${label}` };
  if (style) out.style = style;
  return out;
}

/** onClick → morda-колбэк: после клика окно перерисовывается (как у GramIO);
 * если onClick сам навигировал (replace) — morda пропускает лишний рендер. */
const click =
  (fn: OnClick) =>
  async (ctx: DialogContext): Promise<void> => {
    await fn(ctx as unknown as ClickCtx);
    ctx.dialog.invalidate();
  };

function actBtn(
  emoji: string,
  glyph: string,
  label: string,
  id: string,
  onClick: OnClick,
  style?: BtnStyle,
): DialogButton {
  return { ...chrome(emoji, glyph, label, style), id, onClick: click(onClick) };
}

function navBtn(emoji: string, glyph: string, label: string, state: string, style?: BtnStyle): DialogButton {
  return { ...chrome(emoji, glyph, label, style), id: `to:${state}`, onClick: (ctx) => ctx.dialog.replace(state) };
}

/** Group({ width }) GramIO: все кнопки подряд, нарезанные по width в ряд. */
function chunk<T>(items: readonly T[], width: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += width) rows.push(items.slice(i, i + width));
  return rows;
}

/** userId из ctx.from; фолбэк на чат — у background()-рендера from нет, а чат лички = юзер. */
const uidOf = (ctx: { from?: { id: number }; chat?: { id: number } }): number => ctx.from?.id ?? ctx.chat?.id ?? 0;

type LoginData = {
  login?: LoginInfo;
  loginMsg?: string;
  failReason?: string;
  logoutMsg?: string;
  alreadyIn?: boolean;
};

const toLoginInfo = (st: DeviceAuthState): LoginInfo => ({
  userCode: st.userCode,
  verificationUrl: st.verificationUrl,
  mins: Math.floor(st.expiresIn / 60),
});

/** dialog.switchTo(state, { data }) GramIO: слить data в бэг диалога и сменить окно на месте
 * (Object.assign — та же семантика слияния). */
async function switchTo(
  dialog: Pick<DialogControl, "replace" | "setData">,
  state: string,
  data: LoginData,
): Promise<void> {
  await dialog.setData(data);
  await dialog.replace(state);
}

/** Device-flow: проверки → старт → окно `login`. Async-колбэки успеха/провала
 * правят сообщение диалога ИЗВНЕ хендлера через container.dialogs.background(api, key):
 * key = id чата лички (дефолтный getKey morda). Окно меняется на месте (replace правит
 * то сообщение, что только что отправил start() из /login — второго не будет). */
export async function startLogin(
  dialog: Pick<DialogControl, "replace" | "setData">,
  bot: ApiBot,
  container: Container,
  userId: number,
): Promise<void> {
  if (await container.usersDb.getToken(userId)) {
    await switchTo(dialog, "login_done", { loginMsg: ALREADY_IN, alreadyIn: true });
    return;
  }
  const pending = container.authService.isPending(userId) ? container.authService.getState(userId) : null;
  if (pending) {
    await switchTo(dialog, "login", { login: toLoginInfo(pending) });
    return;
  }
  // device-flow рендерит извне хендлера через background(); try/catch — pollLoop detached
  const finishLogin = async (uid: number, state: string, patch: LoginData): Promise<void> => {
    try {
      const mgr = await container.dialogs?.background(bot.api, String(uid));
      if (!mgr) return;
      await switchTo(mgr, state, patch);
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
    await switchTo(dialog, "login_fail", { failReason: LOGIN_START_FAILED });
    return;
  }
  await switchTo(dialog, "login", { login: toLoginInfo(state) });
}

export async function startLogout(
  dialog: Pick<DialogControl, "replace" | "setData">,
  container: Container,
  userId: number,
): Promise<void> {
  container.authService.cancelAuth(userId); // незавершённый device-flow не должен залогинить после выхода
  const deleted = await container.usersDb.delete(userId);
  // иначе закэшированный YandexClient/SearchService переживает logout — держит
  // расшифрованный токен и историю юзера в памяти до истечения TTL кэша
  container.invalidateTokenCacheForUser(userId);
  container.albumService.forgetUser(userId);
  await switchTo(dialog, "logout_done", { logoutMsg: deleted ? LOGOUT_DONE : NOT_LOGGED_IN });
}

export function buildMenuDialog(bot: ApiBot, container: Container): DialogDef {
  const isLoggedIn = async (userId: number): Promise<boolean> => Boolean(await container.usersDb.getToken(userId));
  const settingsOf = (ctx: DialogContext): Promise<UserSettings> => container.getUserSettings(uidOf(ctx));

  // действия шлют новые сообщения, меню-сообщение не трогают
  const dmAction =
    (
      label: string,
      action: (
        bot: ApiBot,
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
      // долгая работа (Яндекс, рендер карточки — секунды и больше) идёт ВНЕ KeyedLock morda:
      // меню-сообщение она не трогает, а под локом ждали бы все клики и текст этого чата
      void action(bot, chatId, tgUserOf(ctx.from), container, null).catch((e: unknown) => {
        log.error(`[menu] ${label}: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
        incCounter("errors_total");
      });
    };
  const onCard: OnClick = dmAction(TOAST_DRAWING_CARD, renderNowPlaying);
  const onCurrent: OnClick = dmAction(TOAST_FINDING_PLAYING, sendCurrentTrack);
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
    await safeAnswerCb(ctx, LOGIN_CANCELLED);
    await ctx.dialog.replace("main");
  };

  // карточка+трек — один тумблер прямо в разделе «карточка», без отдельного окна
  const onRichToggle: OnClick = richToggleOnClick(container);

  // stateless-радио — источник истины settingsDb (Postgres); текущий пункт помечен « ✓»
  const radio = (
    s: UserSettings,
    opts: {
      id: string;
      values: readonly string[];
      label: (v: string) => string;
      current: (s: UserSettings) => string;
      save: (userId: number, v: string) => Promise<string>;
    },
  ): DialogButton[][] => {
    const onClick = radioOnClick(container, opts.label, opts.save);
    const cur = opts.current(s);
    return opts.values.map((v) => [
      {
        id: `${opts.id}:${v}`,
        label: v === cur ? `${opts.label(v)} ✓` : opts.label(v),
        onClick: click((ctx) => onClick(ctx, v)),
      },
    ]);
  };

  const fields = (s: UserSettings): DialogButton[][] =>
    CARD_TOGGLES.map((v) => [
      {
        id: `card_fields:${v}`,
        label: fieldToggleText(cardFieldLabel(v), Boolean(s.card_toggles[v as CardToggleName])),
        onClick: click(async (ctx) => {
          const cur = await container.getUserSettings(ctx.from.id);
          const next = !cur.card_toggles[v as CardToggleName];
          await container.settingsDb.setCardToggle(ctx.from.id, v, next);
          container.invalidateUserSettings(ctx.from.id);
          await safeAnswerCb(ctx, fieldToggleToast(cardFieldLabel(v), next));
          ctx.dialog.invalidate();
        }),
      },
    ]);

  const back = (state: string): DialogButton => navBtn("⬅️", "←", MENU_BTN.back, state);
  const current = (): DialogButton => actBtn("🎶", "♪", MENU_BTN.current, "current", onCurrent);
  const card = (): DialogButton => actBtn("🖼", "◫", MENU_BTN.card, "card", onCard);
  const login = (label: string = MENU_BTN.login): DialogButton =>
    actBtn(LOGIN_EMOJI, "⏻", label, "login", onLogin, "success");
  const home = (): DialogButton => navBtn("🏠", "⌂", MENU_BTN.home, "main", "primary");
  const help = (): DialogButton => navBtn("❓", "?", MENU_BTN.help, "help");

  // радио-окно настроек: пункты по одному в ряд + «назад»
  const radioWindow =
    (text: () => WindowView["text"], backTo: string, opts: Parameters<typeof radio>[1]) =>
    async (ctx: DialogContext): Promise<WindowView> => {
      const s = await settingsOf(ctx);
      return { text: text(), keyboard: [...radio(s, opts), [back(backTo)]] };
    };

  const richIcon = iconFor("📨"); // 🧩 уже у «подпись и кнопки»
  const ld = (data: Record<string, unknown>): LoginData => data as LoginData;

  return {
    main: async (ctx) => {
      const loggedIn = await isLoggedIn(uidOf(ctx));
      return {
        text: startText(loggedIn, container.botUsername),
        linkPreview: false,
        keyboard: loggedIn
          ? [
              ...chunk([current(), card(), navBtn("⚙️", "⚙", MENU_BTN.settings, "settings"), help()], 2),
              [actBtn("🚪", "⏏", MENU_BTN.logout, "logout", onLogout, "danger")],
            ]
          : chunk([login(), help()], 1),
      };
    },

    help: async (ctx) => {
      const loggedIn = await isLoggedIn(uidOf(ctx));
      return {
        text: helpText(container.botUsername),
        linkPreview: false,
        keyboard: loggedIn ? chunk([current(), card(), home()], 2) : chunk([login(), home()], 1),
      };
    },

    settings: async (ctx) => {
      const s = await settingsOf(ctx);
      return {
        text: settingsMainText(s),
        keyboard: [[navBtn("🎧", "♪", MENU_BTN.track, "s_track"), navBtn("🖼", "◫", MENU_BTN.card, "s_card")], [home()]],
      };
    },

    s_track: async (ctx) => {
      const s = await settingsOf(ctx);
      return {
        text: trackRootText(s),
        keyboard: chunk(
          [
            navBtn("🎛", "☰", MENU_BTN.quality, "s_quality"),
            navBtn("🗂", "✉", MENU_BTN.layout, "s_layout"),
            navBtn("📤", "↥", MENU_BTN.sendMode, "s_sendmode"),
            back("settings"),
          ],
          1,
        ),
      };
    },

    s_layout: radioWindow(layoutPickText, "s_track", {
      id: "track_layout",
      values: ["button", "text", "both", "none"],
      label: trackLayoutLabel,
      current: (s) => s.track_layout,
      save: (u, v) => container.settingsDb.setTrackLayout(u, v),
    }),

    s_sendmode: radioWindow(sendModePickText, "s_track", {
      id: "track_send_mode",
      values: ["stub", "text_media"],
      label: trackSendModeLabel,
      current: (s) => s.track_send_mode,
      save: (u, v) => container.settingsDb.setTrackSendMode(u, v),
    }),

    s_quality: radioWindow(qualityPickText, "s_track", {
      id: "track_quality",
      values: ["best", "economy", "lossless"],
      label: trackQualityLabel,
      current: (s) => s.track_quality,
      save: (u, v) => container.settingsDb.setTrackQuality(u, v),
    }),

    s_card: async (ctx) => {
      const s = await settingsOf(ctx);
      const richText = richToggleText(richLabel(richCurrent(s)));
      const richBtn: CallbackButton = {
        id: "rich_toggle",
        label: richIcon ? richText : `◧ ${richText}`,
        ...(richIcon ? { icon: richIcon } : {}),
        onClick: click(onRichToggle),
      };
      return {
        text: cardRootText(s),
        keyboard: [
          [
            navBtn("📝", "▤", MENU_BTN.fields, "s_card_fields"),
            navBtn("📊", "∿", MENU_BTN.progress, "s_card_progress"),
          ],
          [navBtn("📐", "⬚", MENU_BTN.aspect, "s_card_aspect"), navBtn("🧩", "▦", MENU_BTN.layout, "s_card_layout")],
          [richBtn],
          [back("settings")],
        ],
      };
    },

    s_card_layout: radioWindow(cardLayoutPickText, "s_card", {
      id: "card_layout",
      values: ["button", "text", "both", "none"],
      label: cardLayoutLabel,
      current: (s) => s.card_layout,
      save: (u, v) => container.settingsDb.setCardLayout(u, v),
    }),

    s_card_fields: async (ctx) => {
      const s = await settingsOf(ctx);
      return { text: cardFieldsText(s.card_toggles), keyboard: [...fields(s), [back("s_card")]] };
    },

    s_card_progress: radioWindow(cardProgressText, "s_card", {
      id: "card_progress",
      values: ["wavy", "bar"],
      label: cardProgressLabel,
      current: (s) => s.card_progress,
      save: (u, v) => container.settingsDb.setCardProgress(u, v),
    }),

    s_card_aspect: radioWindow(cardAspectPickText, "s_card", {
      id: "card_aspect",
      values: [...CARD_ASPECTS],
      label: cardAspectLabel,
      current: (s) => s.card_aspect,
      save: (u, v) => container.settingsDb.setCardAspect(u, v),
    }),

    // данные окон — из frame.data (не из ctx): под background() ctx headless
    login: (_ctx, frame) => {
      const l = ld(frame.data).login;
      const cont = chrome("➡️", "▸", MENU_BTN.continueLogin, "success");
      return {
        text: l ? deviceFlowText(l) : format`${LOGIN_PREPARING}`,
        keyboard: [
          [{ ...cont, url: l?.verificationUrl ?? "https://music.yandex" }],
          [actBtn("❌", "✕", MENU_BTN.cancel, "cancel_login", onCancelLogin, "danger")],
        ],
      };
    },

    login_done: (_ctx, frame) => {
      const d = ld(frame.data);
      return {
        text: format`${d.loginMsg ?? LOGIN_DONE_FALLBACK}`,
        keyboard: d.alreadyIn
          ? [[actBtn("🔄", "↻", MENU_BTN.switchAccount, "switch_account", onSwitchAccount)], [home()]]
          : [[current(), card()], [home()]],
      };
    },

    login_fail: (_ctx, frame) => {
      const r = ld(frame.data).failReason;
      const why = r === "timeout" ? LOGIN_TIMEOUT_REASON : (r ?? "");
      return { text: loginFailed(why), keyboard: [[login(MENU_BTN.retryLogin)], [home()]] };
    },

    logout_done: (_ctx, frame) => ({
      text: format`${ld(frame.data).logoutMsg ?? LOGOUT_DONE_FALLBACK}`,
      keyboard: [[login()], [home()]],
    }),
  };
}

/** то, что контейнеру нужно от диалогов вне хендлеров. */
export interface MenuDialogs {
  /** headless-контрол открытого диалога (device-flow); undefined — диалога нет. */
  background(api: ApiBot["api"], key: string): Promise<DialogControl | undefined>;
  /** забыть состояние диалога чата, НЕ трогая его сообщение (см. startMenu). */
  reset(chatId: number): Promise<void>;
}

export function createMenuDialogs(
  bot: ApiBot,
  container: Container,
  storage: StorageAdapter<DialogState>,
): { plugin: ReturnType<typeof createDialogs>["plugin"]; dialogs: MenuDialogs } {
  const { plugin, background } = createDialogs(buildMenuDialog(bot, container), {
    storage,
    prefix: DIALOG_PREFIX,
    events: {
      // тост доходит, потому что dialogAnswerGate придержал пустой answer morda
      onStale: (ctx) => safeAnswerCb(ctx as unknown as ClickCtx, STALE_MENU),
    },
  });
  return {
    plugin,
    dialogs: {
      // тот же узкий ретрай, что у кликов (см. mordaRetry.ts)
      background: (api, key) => background(retryingApi(api), key),
      reset: async (chatId) => {
        await storage.delete(stateKey(chatId));
      },
    },
  };
}

/** /start, /help, /settings: свежее меню (ResetStack у GramIO). Прежнее меню-сообщение
 * остаётся в чате — его кнопки отвечают «меню устарело». */
export async function startMenu(
  ctx: { chat?: { id: number }; dialog: Pick<DialogControl, "start"> },
  container: Pick<Container, "dialogs">,
  window: string,
): Promise<void> {
  if (ctx.chat) await container.dialogs?.reset(ctx.chat.id);
  await ctx.dialog.start(window);
}

/** Ставится ПЕРЕД плагином morda. На dlg-кнопках:
 *  • пустой ctx.answerCallbackQuery() (morda гасит спиннер в finally, до onStale)
 *    откладывается до конца апдейта — иначе тост «меню устарело» из onStale упирался
 *    бы в уже отвеченный query;
 *  • если за апдейт никто не ответил (обычный клик без тоста, или состояния нет —
 *    диалог истёк по TTL) — один пустой answer в конце, как silentAnswer у GramIO. */
export function dialogAnswerGate<C extends Context>(): Middleware<C> {
  return async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    if (ctx.updateType !== "callback_query" || !data?.startsWith(`${DIALOG_PREFIX}:`)) return next();
    const c = ctx as unknown as {
      answer?: (...args: unknown[]) => Promise<unknown>;
      answerCallbackQuery: (extra?: Record<string, unknown>) => Promise<boolean>;
    };
    const real = c.answerCallbackQuery.bind(ctx);
    let answered = false;
    const sugar = c.answer;
    if (sugar) {
      c.answer = (...args) => {
        answered = true;
        return sugar(...args);
      };
    }
    c.answerCallbackQuery = (extra) => {
      if (!extra || Object.keys(extra).length === 0) return Promise.resolve(true);
      answered = true;
      return real(extra);
    };
    try {
      await next();
    } finally {
      if (!answered) await real().catch(() => {});
    }
  };
}
