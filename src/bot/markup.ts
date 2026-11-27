/** inline-клавиатуры — единый источник истины.
 *
 * callback_data — literal-строки с RegExp-роутингом в хендлерах, а не
 * callbackData-схемы yaebal.
 *
 * yaebal InlineKeyboard: декор кнопки — { style, icon } (icon → icon_custom_emoji_id
 * на проводе), а pattern() раскладывает УЖЕ добавленные кнопки (у GramIO — лениво при
 * сборке), поэтому pattern() зовём после кнопок.
 *
 * Иконки: кастом-эмодзи (icon_custom_emoji_id, Bot API 10.0) из набора tgiosicons,
 * резолвится на старте (iconSet.ts) по стандартному эмодзи. Фолбэк — монохромный
 * текстовый глиф. Telegram рендерит icon_custom_emoji_id только если у владельца
 * Premium (для сообщений бота в лс/группы) ИЛИ у бота Fragment-username (для всего,
 * включая инлайн). Поэтому:
 *  • dm-кнопки (меню/настройки/логин) — чистая иконка вместо глифа (рендерит Premium);
 *  • инлайн-кнопки (трек/карточка) — глиф + иконка вместе: глиф виден всегда,
 *    кастом-иконка подхватится при наличии Fragment-username. */
import { InlineKeyboard } from "yaebal";
import { trackUrl } from "../yandex/urls.ts";
import { iconFor } from "./iconSet.ts";
import {
  ADMIN,
  albumRetryButton,
  BTN_CANCEL_UPLOAD,
  BTN_DOWNLOADING,
  BTN_LISTEN_DM,
  BTN_LISTEN_PLAYER,
  BTN_OPEN,
  BTN_RETRY,
  MENU_BTN,
} from "./texts.ts";

type BtnStyle = "danger" | "primary" | "success";
interface BtnOpts {
  style?: BtnStyle;
  /** custom_emoji_id; ключ декора yaebal — `icon`, не `icon_custom_emoji_id`. */
  icon?: string;
}

function dmText(
  kb: InlineKeyboard,
  emoji: string,
  glyph: string,
  label: string,
  data: string,
  style?: BtnStyle,
): InlineKeyboard {
  const id = iconFor(emoji);
  const o: BtnOpts = {};
  if (style) o.style = style;
  if (id) {
    o.icon = id;
    kb.text(label, data, o);
  } else kb.text(`${glyph} ${label}`, data, o);
  return kb;
}

// инлайн-кнопки (трек/карточка) — без глифов/эмодзи: кастом-иконки без Fragment
// не рендерятся. Исключение — сердце лайка (kb.text("♥") в trackMarkup).
function inlineText(
  kb: InlineKeyboard,
  _emoji: string,
  glyph: string,
  label: string,
  data: string,
  style?: BtnStyle,
): InlineKeyboard {
  const o: BtnOpts = {};
  if (style) o.style = style;
  kb.text(label || glyph, data, o); // glyph только если лейбла нет вовсе
  return kb;
}

function inlineUrl(
  kb: InlineKeyboard,
  _emoji: string,
  _glyph: string,
  label: string,
  url: string,
  style?: BtnStyle,
): InlineKeyboard {
  const o: BtnOpts = {};
  if (style) o.style = style;
  kb.url(label, url, o);
  return kb;
}

export function loadingMarkup(trackId: string | number): InlineKeyboard {
  const kb = new InlineKeyboard();
  inlineText(kb, "⌛️", "⧖", BTN_DOWNLOADING, `load:${trackId}`);
  return kb;
}

export function progressMarkup(trackId: string | number, label: string): InlineKeyboard {
  return new InlineKeyboard().text(label, `load:${trackId}`);
}

/** единая кнопка лайка — всегда красное сердце (состояние не отображается;
 * лайк ставится в библиотеку того, кто нажал). В одну линию с «открыть». */
export function trackMarkup(trackId: string | number, withLike = false): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (!withLike) {
    inlineUrl(kb, "▶️", "▷", BTN_OPEN, trackUrl(trackId));
    return kb;
  }
  // heart: премиум-иконка есть, но на инлайне рендерится только с Fragment-username
  // (его нет) → держим глиф ♥ видимым текстом, чтобы кнопка не была пустой.
  const heartId = iconFor("❤️");
  kb.text("♥", `like:t:${trackId}`, heartId ? { icon: heartId } : {});
  inlineUrl(kb, "▶️", "▷", BTN_OPEN, trackUrl(trackId));
  return kb.pattern([2]);
}

export function retryMarkup(trackId: string | number): InlineKeyboard {
  const kb = new InlineKeyboard();
  inlineText(kb, "🔄", "↻", BTN_RETRY, `load:${trackId}`);
  return kb;
}

/** повтор рендера карточки (npc:/lyc:) — `crd:<resultId>`; null, если не влезает в 64 байта callback_data. */
export function cardRetryMarkup(resultId: string): InlineKeyboard | null {
  const data = `crd:${resultId}`;
  if (Buffer.byteLength(data) > 64) return null;
  const kb = new InlineKeyboard();
  inlineText(kb, "🔄", "↻", BTN_RETRY, data);
  return kb;
}

export function cancelAlbumMarkup(): InlineKeyboard {
  const kb = new InlineKeyboard();
  dmText(kb, "❌", "✕", BTN_CANCEL_UPLOAD, "cancel_album", "danger");
  return kb;
}

export function albumRetryMarkup(messageId: number, label: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  dmText(kb, "🔄", "↻", albumRetryButton(label), `album_retry:${messageId}`);
  return kb;
}

/** /broadcast: «разослать это N пользователям?» */
export function broadcastConfirmMarkup(): InlineKeyboard {
  const kb = new InlineKeyboard();
  dmText(kb, "✅", "✓", ADMIN.btnBroadcast, "broadcast_confirm", "success");
  dmText(kb, "❌", "✕", ADMIN.btnCancel, "broadcast_cancel", "danger");
  return kb.pattern([2]);
}

/** кнопка остановки уже идущей рассылки. */
export function broadcastSendingMarkup(): InlineKeyboard {
  const kb = new InlineKeyboard();
  dmText(kb, "⛔", "■", ADMIN.btnStop, "broadcast_stop", "danger");
  return kb;
}

// у карточки (фото) лайк-кнопки нет вовсе — только «слушать»; лайк доступен
// на аудио-результате трека (trackMarkup withLike=true).
export function nowPlayingMarkup(trackId: string | number, botUsername: string | null): InlineKeyboard {
  // start=track_<uuid> не работает (START_TRACK_RE — только цифры): для подкастов/аудиокниг кнопки «в лс» нет
  const dmOk = Boolean(botUsername) && /^\d+$/.test(String(trackId));
  const kb = new InlineKeyboard();
  if (dmOk) {
    inlineUrl(kb, "💬", "▷", BTN_LISTEN_DM, `https://t.me/${botUsername}?start=track_${trackId}`);
  }
  inlineUrl(kb, "🔗", "↗", BTN_LISTEN_PLAYER, trackUrl(trackId));
  return kb.pattern([dmOk ? 2 : 1]);
}

/** главная панель /health: вход в детальный статус Яндекс Музыки. */
export function healthMarkup(): InlineKeyboard {
  const kb = new InlineKeyboard();
  dmText(kb, "🎵", "♪", ADMIN.ymTitle, "health:ym", "primary");
  return kb;
}

/** детальная панель Яндекс Музыки: обновить и назад. */
export function yandexHealthMarkup(): InlineKeyboard {
  const kb = new InlineKeyboard();
  dmText(kb, "🔄", "↻", ADMIN.btnRefresh, "health:ym", "primary");
  dmText(kb, "⬅️", "←", MENU_BTN.back, "health:main");
  return kb.pattern([1, 1]);
}
