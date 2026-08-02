/** inline-клавиатуры — единый источник истины.
 *
 * callback_data — literal-строки с RegExp-роутингом в хендлерах, а не
 * CallbackData-схемы gramio.
 *
 * Иконки: кастом-эмодзи (icon_custom_emoji_id, Bot API 10.0) из набора tgiosicons,
 * резолвится на старте (iconSet.ts) по стандартному эмодзи. Фолбэк — монохромный
 * текстовый глиф. Telegram рендерит icon_custom_emoji_id только если у владельца
 * Premium (для сообщений бота в лс/группы) ИЛИ у бота Fragment-username (для всего,
 * включая инлайн). Поэтому:
 *  • dm-кнопки (меню/настройки/логин) — чистая иконка вместо глифа (рендерит Premium);
 *  • инлайн-кнопки (трек/карточка) — глиф + иконка вместе: глиф виден всегда,
 *    кастом-иконка подхватится при наличии Fragment-username. */
import { InlineKeyboard } from "gramio";
import { trackUrl } from "../yandex/urls.ts";
import { iconFor } from "./iconSet.ts";

type BtnStyle = "danger" | "primary" | "success";
interface BtnOpts {
  style?: BtnStyle;
  icon_custom_emoji_id?: string;
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
    o.icon_custom_emoji_id = id;
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
  inlineText(kb, "⌛️", "⧖", "загружается...", `load:${trackId}`);
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
    inlineUrl(kb, "▶️", "▷", "открыть", trackUrl(trackId));
    return kb;
  }
  // heart: премиум-иконка есть, но на инлайне рендерится только с Fragment-username
  // (его нет) → держим глиф ♥ видимым текстом, чтобы кнопка не была пустой.
  kb.pattern([2]);
  const heartId = iconFor("❤️");
  kb.text("♥", `like:t:${trackId}`, heartId ? { icon_custom_emoji_id: heartId } : {});
  inlineUrl(kb, "▶️", "▷", "открыть", trackUrl(trackId));
  return kb;
}

export function retryMarkup(trackId: string | number): InlineKeyboard {
  const kb = new InlineKeyboard();
  inlineText(kb, "🔄", "↻", "загрузить снова", `load:${trackId}`);
  return kb;
}

export function cancelAlbumMarkup(): InlineKeyboard {
  const kb = new InlineKeyboard();
  dmText(kb, "❌", "✕", "отменить", "cancel_album", "danger");
  return kb;
}

export function albumRetryMarkup(messageId: number, label: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  dmText(kb, "🔄", "↻", `повторить ${label}`, `album_retry:${messageId}`);
  return kb;
}

/** /broadcast: «разослать это N пользователям?» */
export function broadcastConfirmMarkup(): InlineKeyboard {
  const kb = new InlineKeyboard().pattern([2]);
  dmText(kb, "✅", "✓", "разослать", "broadcast_confirm", "success");
  dmText(kb, "❌", "✕", "отмена", "broadcast_cancel", "danger");
  return kb;
}

/** кнопка остановки уже идущей рассылки. */
export function broadcastSendingMarkup(): InlineKeyboard {
  const kb = new InlineKeyboard();
  dmText(kb, "⛔", "■", "остановить рассылку", "broadcast_stop", "danger");
  return kb;
}

// у карточки (фото) лайк-кнопки нет вовсе — только «слушать»; лайк доступен
// на аудио-результате трека (trackMarkup withLike=true).
export function nowPlayingMarkup(trackId: string | number, botUsername: string | null): InlineKeyboard {
  const kb = new InlineKeyboard().pattern([botUsername ? 2 : 1]);
  if (botUsername) {
    inlineUrl(kb, "💬", "▷", "слушать в лс", `https://t.me/${botUsername}?start=track_${trackId}`);
  }
  inlineUrl(kb, "🔗", "↗", "слушать в плеере", trackUrl(trackId));
  return kb;
}
