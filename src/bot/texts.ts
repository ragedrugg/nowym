/** Все пользовательские тексты бота — единственный источник.
 *
 * Сгруппировано по ситуациям; параметризованные тексты — функции. Логи, ошибки
 * для разработчика и данные (теги, имена файлов, картинка карточки) сюда не входят.
 *
 * Единый стиль (проверяется test/texts.test.ts):
 *  • строчные буквы, неформальное «ты», коротко; заглавные — только у
 *    пользовательского контента, аббревиатур и «Яндекс Музыка» в админке;
 *  • эмодзи — не больше одного и только в начале строки, по смыслу:
 *    ⏳ ожидание/поиск/лимит, ⬇️ скачивание, 📨 отправка, ❌ ошибка,
 *    ⚠️ частичный успех, ✅ успех, 🎵 музыка/«ничего не играет», 🔐 вход;
 *    тосты и кнопки-статусы inline — без эмодзи (кроме «❤️ лайкнул»);
 *  • без точки в конце; многоточие — символ «…»; «ситуация — действие» через « — »;
 *  • одна формулировка на ситуацию: вход — LOGIN_FIRST, лимит — tooOften,
 *    ошибка — ERROR_RETRY / CB_FAILED, деградация — degradedNote. */
import { blockquote, bold, code, type FormattableString, format, italic, link } from "gramio";
import { botMention, pluralTracks, waitSeconds } from "../infra/text.ts";
import { CARD_TOGGLES, type UserSettings } from "../storage/settings.ts";

// ───────────────────────── меню команд (setMyCommands) ─────────────────────────

export const PUBLIC_COMMANDS = [
  { command: "start", description: "главное меню" },
  { command: "help", description: "как пользоваться" },
  { command: "np", description: "карточка того, что играет" },
  { command: "settings", description: "качество, подписи, карточка" },
  { command: "login", description: "войти в аккаунт" },
  { command: "logout", description: "выйти из аккаунта" },
];

export const ADMIN_COMMANDS = [
  { command: "health", description: "статус и диагностика" },
  { command: "broadcast", description: "рассылка всем" },
];

// ───────────────────────── /start, /help, подсказки ─────────────────────────

/** «набери @bot название в любом чате — или жми кнопки ниже» — общий хвост старта и входа. */
const typeAnywhere = (botUsername: string | null): string =>
  `набери ${botMention(botUsername)} название в любом чате — или жми кнопки ниже`;

export function startText(loggedIn: boolean, botUsername: string | null = null): FormattableString {
  const base = format`👋 привет\n\nэто бот для одного жёлтого музыкального сервиса. кидает треки прямо в телеграм — по названию, по ссылке или просто тот, который у тебя сейчас играет\n\n`;
  const tail = loggedIn ? typeAnywhere(botUsername) : "чтобы всё заработало — войди, это минута";
  return format`${base}${tail}`;
}

export function helpText(botUsername: string | null = null): FormattableString {
  return format`🎵 ${bold("что я умею")}
кидаю треки, альбомы и плейлисты прямо в телеграм — по названию, ссылке, цитате из песни или тот, что играет у тебя сейчас

⌨️ ${bold("inline — в любом чате")}
набери ${code(botMention(botUsername))} и через пробел:
${blockquote(format`${code("название")} — поиск треков (альбом и плейлист — по ссылке)
${code("ссылка")} — трек, альбом или плейлист по ссылке
${code("(пусто)")} — что играет сейчас + карточка
${code('"строка из песни"')} — поиск по цитате + текст песни
${code("недавнее")} — история прослушиваний (листается)
${code("ncore / speed / slow")} + название — эффект: ${EFFECT_NAMES.ncore} / ${EFFECT_NAMES.speed} / ${EFFECT_NAMES.slow}`)}

💬 ${bold("в личке")}
${blockquote(format`ссылка на трек, альбом или плейлист — пришлю сюда (альбом и плейлист — выгрузкой)
кнопка «${MENU_BTN.current}» в меню — пришлю сам трек, который играет сейчас
${code("/np")} — карточка того, что играет сейчас
${code("/settings")} — качество, подписи, карточка
${code("/login")} · ${code("/logout")} — вход и выход`)}`;
}

export const groupHint = (botUsername: string | null): string =>
  `в группах работаю через inline — набери ${botMention(botUsername)} название. настройки и вход — в личке`;
export const privateHint = (botUsername: string | null): string =>
  `так не ищу — набери ${botMention(botUsername)} название в любом чате. в личку можно кидать ссылки на трек, альбом или плейлист. остальное — /help`;

export const STALE_MENU = "это меню устарело — открой заново через /start";

// ───────────────────────── вход и выход ─────────────────────────

/** эмодзи входа — везде один (кнопки меню, inline-кнопка, окно входа). */
export const LOGIN_EMOJI = "🔐";
/** единственный текст «нет входа»: сообщения, алерты, кнопки-статусы. */
export const LOGIN_FIRST = "сначала войди — /login";
/** кнопка над inline-выдачей без входа. */
export const LOGIN_INLINE_BUTTON = `${LOGIN_EMOJI} войти в аккаунт`;

export const ALREADY_IN = "✅ ты уже вошёл\n\nсменить аккаунт — кнопка ниже или /logout";
export const loginOk = (botUsername: string | null): string =>
  `✅ готово, ты в аккаунте\n\n${typeAnywhere(botUsername)}`;
export const LOGIN_DONE_FALLBACK = "✅ готово";
export const LOGIN_PREPARING = "⏳ готовлю вход…";
export const LOGIN_START_FAILED = "сервис входа не ответил";
export const LOGIN_INTERNAL_FAILED = "сбой на стороне бота";
export const LOGIN_TIMEOUT_REASON = "код истёк";
export const LOGIN_CANCELLED = "вход отменён";
export const loginFailed = (why: string): FormattableString =>
  format`❌ не вышло войти — попробуй ещё раз${why ? format`\n\n${italic(why)}` : ""}`;
export const LOGOUT_DONE = "✅ ты вышел из аккаунта\n\nвойти снова — кнопка ниже";
export const LOGOUT_DONE_FALLBACK = "✅ ты вышел из аккаунта";
export const NOT_LOGGED_IN = "ты пока не входил в аккаунт";

export interface LoginInfo {
  userCode: string;
  verificationUrl: string;
  mins: number;
}

export const deviceFlowText = (l: LoginInfo): FormattableString => format`${LOGIN_EMOJI} ${bold("вход в аккаунт")}

1. жми «продолжить»
2. введи код: ${code(l.userCode)}
3. подтверди вход

код живёт ${l.mins} мин

${italic("пароль остаётся у сервиса — ко мне приходит только токен на музыкальный api. в базе он лежит зашифрованным")}`;

// ───────────────────────── лимит запросов ─────────────────────────

/** сообщение в чат и кнопка над inline-выдачей. */
export const tooOften = (retryAfterSec: number): string => `⏳ ${tooOftenButton(retryAfterSec)}`;
/** кнопка-статус под inline-сообщением (без эмодзи). */
export const tooOftenButton = (retryAfterSec: number): string =>
  `слишком часто — подожди ${waitSeconds(retryAfterSec)} сек`;

// ───────────────────────── ошибки ─────────────────────────

/** единственный текст общей ошибки: сообщения и кнопка над inline-выдачей. */
export const ERROR_RETRY = "❌ не вышло — попробуй ещё раз";
/** то же для алертов и тостов (без эмодзи). */
export const CB_FAILED = "не вышло — попробуй ещё раз";
/** алерт, когда кнопка трека больше не работает. */
export const CB_FIND_AGAIN = "не вышло — найди трек заново";

// ───────────────────────── подписи под аудио ─────────────────────────

export const CODEC_LABELS = { flac: "превосходное", aac: "экономичное", mp3: "оптимальное" } as const;
export const kbps = (n: number): string => `${n} кбит/с`;
export const CAPTION_OPEN = "открыть";

// ───────────────────────── что играет / отправка трека в чат ─────────────────────────

export const NOTHING_PLAYING = "🎵 сейчас ничего не играет";
export const ALREADY_SENDING = "⏳ уже отправляю…";
export const FINDING_PLAYING = "⏳ ищу, что играет…";
export const FINDING_TRACK = "⏳ ищу трек…";
/** тосты кнопок меню «что играет» / «карточка». */
export const TOAST_FINDING_PLAYING = "ищу, что играет…";
export const TOAST_DRAWING_CARD = "рисую карточку…";
export const DOWNLOADING_STATUS = "⬇️ качаю…";
export const DELIVERY_UNKNOWN = "⚠️ не вышло подтвердить отправку — проверь чат и повтори, если трека нет";
export const DELIVERY_PARTIAL = "❌ карточка пришла, а трек нет — попробуй ещё раз";
export const TRACK_UNSUPPORTED = "❌ этот трек не поддерживается — он не из каталога";

/** «⚠️ превосходное недоступно — отдаю оптимальное»: rich, чат и подпись. */
export const degradedNote = (quality: string = CODEC_LABELS.mp3): string =>
  `⚠️ превосходное недоступно — отдаю ${quality}`;
export const DEGRADED_NOTE = degradedNote();

export const TOO_LONG_TEXT = "трек слишком длинный для телеграма";
export const TRACK_NOT_FOUND = "трек не найден";
export const NO_VARIANTS = "нет вариантов скачивания";

export type EnsureFailKind = "not_found" | "too_long" | "no_variants" | "failed";

/** итог неудачной закачки — сообщением в чат. */
export function ensureErrorText(kind: EnsureFailKind): FormattableString {
  const text = ensureErrorButton(kind);
  return text ? format`❌ ${text}` : format`❌ не вышло скачать — попробуй ещё раз`;
}

/** итог неудачной закачки — кнопкой-статусом (null → кнопка «загрузить снова»). */
export function ensureErrorButton(kind: EnsureFailKind): string | null {
  return kind === "not_found"
    ? TRACK_NOT_FOUND
    : kind === "too_long"
      ? TOO_LONG_TEXT
      : kind === "no_variants"
        ? NO_VARIANTS
        : null;
}

// ───────────────────────── inline: кнопка над выдачей ─────────────────────────

export const INLINE_SERVICE_DOWN = "⏳ сервис не отвечает — попробуй ещё раз";
export const INLINE_TIMED_OUT = "⏳ не успел — попробуй ещё раз";
export const INLINE_NOTHING_RECENT = "🕗 пока нечего показать";
export const inlineNotFound = (text: string): string =>
  `❌ не найдено: ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`;

// ───────────────────────── inline: кнопки-статусы и тосты ─────────────────────────

export const BTN_DOWNLOADING = "качаю…";
export const BTN_SENDING = "отправляю…";
export const BTN_PREPARING = "готовлю…";
export const BTN_RETRY = "загрузить снова";
export const BTN_OPEN = "открыть";
export const BTN_LISTEN_DM = "слушать в лс";
export const BTN_LISTEN_PLAYER = "слушать в плеере";

export const cbNotYourTrack = (botUsername: string | null): string =>
  `это не твой трек — набери ${botMention(botUsername)} и найди сам`;
export const CB_WAIT = "секунду…";
export const CB_LIKED = "❤️ лайкнул";
export const CB_UNLIKED = "убрал лайк";

// ───────────────────────── inline-результаты ─────────────────────────

export const CARD_RESULT = { label: "оформить карточкой", placeholder: "готовлю карточку…" };
export const RICH_RESULT = { label: "карточка + трек", placeholder: "готовлю карточку и трек…" };
export const LYRICS_RESULT = { label: "карточка с текстом", placeholder: "готовлю карточку с текстом…" };

export function cardCaptionText(trackUrl: string, artist: string, title: string): FormattableString {
  const a = (artist || "").trim();
  const t = (title || "").trim();
  const head = a ? `🎵 ${a} — ${t}` : `🎵 ${t}`;
  return format`${head}, ${link("в плеере", trackUrl)}`;
}

/** «качаю X — Y» → на choose заменяется аудио. */
export const textMediaTitle = (head: string): string => `⬇️ ${head}`;
export const textMediaBody = (head: string): FormattableString => format`⬇️ качаю ${bold(head)}`;
export const TEXT_MEDIA_DESCRIPTION = "нажми — заменю текст на трек";

export const UNTITLED = "без названия";
export const searchTrackCount = (n: number): string => pluralTracks(n);
export const albumResultTitle = (title: string): string => `📀 ${title}`;
export const albumResultText = (head: string, suffix: string, url: string): FormattableString =>
  suffix ? format`📀 ${bold(head)}\n${italic(suffix)}\n\n${url}` : format`📀 ${bold(head)}\n\n${url}`;
export const ALBUM_TO_DM = "выгрузить альбом мне в личку";
export const playlistResultTitle = (title: string): string => `🎵 ${title}`;
export const playlistResultText = (title: string, suffix: string, url: string): FormattableString =>
  suffix ? format`🎵 ${bold(title)}\n${italic(suffix)}\n\n${url}` : format`🎵 ${bold(title)}\n\n${url}`;
export const PLAYLIST_DESCRIPTION = "плейлист";
export const PLAYLIST_TO_DM = "выгрузить плейлист мне в личку";

/** названия аудио-эффектов: в /help и суффиксом в названии трека. */
export const EFFECT_NAMES = {
  ncore: "найткор",
  speed: "ускорено",
  slow: "замедлено + реверб",
} as const;
export const EFFECT_SUFFIX = {
  ncore: `(${EFFECT_NAMES.ncore})`,
  speed: `(${EFFECT_NAMES.speed})`,
  slow: `(${EFFECT_NAMES.slow})`,
} as const;

// ───────────────────────── альбомы и плейлисты ─────────────────────────

export const ALBUM_NOUN = "альбом";
export const PLAYLIST_NOUN = "плейлист";
export const UPLOAD_BUSY = "⏳ у тебя уже идёт выгрузка — дождись или жми «отменить»";
export const findingRelease = (noun: string): FormattableString => format`⏳ ищу ${noun}…`;
export const NO_TRACKS = "❌ нет доступных треков";
export const uploadingTracks = (caption: FormattableString, tracks: string): FormattableString =>
  format`${caption}\n\n⬇️ качаю ${tracks}…`;
export const ALBUM_NOT_FOUND = "❌ альбом не найден или недоступен";
export const PLAYLIST_NOT_FOUND = "❌ плейлист не найден, недоступен или пуст";
export const CB_CANCELLING = "отменяю…";
export const CB_NOTHING_TO_CANCEL = "нечего отменять";
export const CB_TOO_LATE = "слишком поздно — кинь ссылку ещё раз";
export const CB_NOT_YOUR_UPLOAD = "это не твоя выгрузка";
export const CB_UPLOAD_BUSY = "у тебя уже идёт выгрузка";
export const CB_RETRYING = "повторяю…";
export const BTN_CANCEL_UPLOAD = "отменить";
export const albumRetryButton = (tracks: string): string => `повторить ${tracks}`;

export const resumeNeedsLogin = (noun: string): FormattableString =>
  format`❌ не вышло продолжить — войди через /login и кинь ${noun} ещё раз`;
export const resumeGone = (noun: string): FormattableString => format`❌ ${noun} больше недоступен`;
export const resumeAlreadyDone = (noun: string): FormattableString => format`✅ ${noun} уже отправлен`;
export const resumeContinue = (done: number, total: number, remaining: number): FormattableString =>
  format`🔄 продолжаю с того места: ${done}/${total} уже отправлено, осталось ${remaining}`;
export const uploadCancelled = (header: FormattableString, sent: number, total: number): FormattableString =>
  format`${header}\n⛔ отменено — отправлено ${sent}/${total}`;
export const nowSendingTrack = (title: string): string => `«${title}»`;
export const nowSendingBatch = (n: number): string => pluralTracks(n);
export const etaLeft = (eta: string): string => `, осталось ~${eta}`;
export const sendingNow = (what: string): FormattableString => format`📨 отправляю ${what}`;
export const PREPARING_SEND = "📨 готовлю отправку…";
export const downloadingInParallel = (tracks: string): FormattableString => format`⬇️ параллельно качаю ${tracks}`;
export const FAILED_LIST_HEADER = "❌ не вышло:";
export const UPLOAD_DONE = "✅ готово";

// ───────────────────────── меню: настройки ─────────────────────────

export const TRACK_LAYOUT_LABELS: Record<string, string> = {
  button: "кнопка",
  text: "текст",
  both: "всё",
  none: "ничего",
};
export const TRACK_SEND_MODE_LABELS: Record<string, string> = { stub: "пустышка", text_media: "текст → медиа" };
export const TRACK_QUALITY_LABELS: Record<string, string> = {
  best: CODEC_LABELS.mp3,
  economy: CODEC_LABELS.aac,
  lossless: CODEC_LABELS.flac,
};
export const CARD_PROGRESS_LABELS: Record<string, string> = { wavy: "волна", bar: "полоска" };
export const CARD_FIELD_LABELS: Record<string, string> = {
  album: "альбом",
  type: "тип релиза",
  year: "год",
  label: "лейбл",
  track_no: "номер трека",
  avatar: "аватарка",
};
export const CARD_ASPECT_LABELS: Record<string, string> = { "16:9": "16:9", "9:16": "9:16" };
export const trackLayoutLabel = (v: string): string => TRACK_LAYOUT_LABELS[v] ?? TRACK_LAYOUT_LABELS.button!;
export const trackSendModeLabel = (v: string): string => TRACK_SEND_MODE_LABELS[v] ?? TRACK_SEND_MODE_LABELS.stub!;
export const trackQualityLabel = (v: string): string => TRACK_QUALITY_LABELS[v] ?? TRACK_QUALITY_LABELS.best!;
export const cardLayoutLabel = trackLayoutLabel;
export const cardProgressLabel = (v: string): string => CARD_PROGRESS_LABELS[v] ?? CARD_PROGRESS_LABELS.wavy!;
export const cardFieldLabel = (v: string): string => CARD_FIELD_LABELS[v] ?? v;
export const cardAspectLabel = (v: string): string => CARD_ASPECT_LABELS[v] ?? v;
export const onOffLabel = (on: boolean): string => (on ? "вкл" : "выкл");
export const richLabel = (v: string): string => onOffLabel(v === "on");

export const toggleSummary = (t: Record<string, boolean>): string => {
  const on = CARD_TOGGLES.filter((n) => t[n]).map(cardFieldLabel);
  return on.length > 0 ? on.join(", ") : "ничего не выбрано";
};

export const settingsMainText = (s: UserSettings): FormattableString => format`${bold("⚙️ настройки")}

${bold("🎧 трек")}
качество: ${bold(trackQualityLabel(s.track_quality))}
подпись и кнопки: ${bold(trackLayoutLabel(s.track_layout))}
способ отправки: ${bold(trackSendModeLabel(s.track_send_mode))}

${bold("🖼 карточка")}
прогресс: ${bold(cardProgressLabel(s.card_progress))}
соотношение: ${bold(cardAspectLabel(s.card_aspect))}
подпись и кнопки: ${bold(cardLayoutLabel(s.card_layout))}
поля: ${italic(toggleSummary(s.card_toggles))}
карточка + трек: ${bold(onOffLabel(s.rich_messages))}`;

export const trackRootText = (s: UserSettings): FormattableString => format`${bold("🎧 трек")}

качество: ${bold(trackQualityLabel(s.track_quality))}
подпись и кнопки: ${bold(trackLayoutLabel(s.track_layout))}
способ отправки: ${bold(trackSendModeLabel(s.track_send_mode))}`;

export const layoutPickText = (): FormattableString => format`${bold("подпись и кнопки трека")}

${bold("кнопка")} — под аудио кнопка «открыть»
${bold("текст")} — подпись со ссылкой «открыть»
${bold("всё")} — и подпись, и кнопка
${bold("ничего")} — только аудиофайл`;

export const sendModePickText = (): FormattableString => format`${bold("способ отправки (в inline)")}

${bold("пустышка")} — сразу аудиофайл, который подменяется на трек
${bold("текст → медиа")} — сначала «качаю артист — название», потом это сообщение становится треком`;

export const qualityPickText = (): FormattableString => format`${bold("качество звука")}

${bold(CODEC_LABELS.mp3)} — mp3 до 320 кбит/с
${bold(CODEC_LABELS.aac)} — до 192 кбит/с, легче и быстрее
${bold(CODEC_LABELS.flac)} — flac без потерь, файлы тяжёлые`;

export const cardRootText = (s: UserSettings): FormattableString => format`${bold("🖼 карточка")}

поля: ${italic(toggleSummary(s.card_toggles))}
прогресс: ${bold(cardProgressLabel(s.card_progress))}
соотношение: ${bold(cardAspectLabel(s.card_aspect))}
подпись и кнопки: ${bold(cardLayoutLabel(s.card_layout))}

${bold("карточка + трек")}: ${bold(onOffLabel(s.rich_messages))}
${italic("карточка и трек приходят одним сообщением; если не выйдет — пришлю двумя")}`;

export const cardAspectPickText = (): FormattableString => format`${bold("соотношение сторон")}

${bold("16:9")} — широкоэкранный (по умолчанию)
${bold("9:16")} — вертикальный`;

export const cardLayoutPickText = (): FormattableString => format`${bold("подпись и кнопки карточки")}

${bold("кнопка")} — под фото кнопки «${BTN_LISTEN_DM}» / «${BTN_LISTEN_PLAYER}»
${bold("текст")} — подпись со ссылкой «в плеере»
${bold("всё")} — и подпись, и кнопки
${bold("ничего")} — только фото`;

export const cardFieldsText = (t: Record<string, boolean>): FormattableString =>
  format`${bold("поля карточки")}\n\n${italic(toggleSummary(t))}`;

export const cardProgressText = (): FormattableString => format`${bold("прогресс трека")}

${bold("волна")} — волнистый
${bold("полоска")} — прямая`;

export const savedToast = (label: string): string => `ок: ${label}`;
export const richToggleText = (label: string): string => `карточка + трек: ${label}`;
export const fieldToggleText = (field: string, on: boolean): string => `${field}: ${onOffLabel(on)}`;
export const fieldToggleToast = fieldToggleText;

// ───────────────────────── меню: кнопки ─────────────────────────

export const MENU_BTN = {
  current: "что играет",
  card: "карточка",
  settings: "настройки",
  help: "что умею",
  logout: "выйти",
  login: "войти",
  home: "в меню",
  track: "трек",
  quality: "качество",
  layout: "подпись и кнопки",
  sendMode: "способ отправки",
  fields: "поля",
  progress: "прогресс",
  aspect: "соотношение",
  back: "назад",
  continueLogin: "продолжить",
  cancel: "отмена",
  switchAccount: "сменить аккаунт",
  retryLogin: "попробовать снова",
} as const;

// ───────────────────────── админ ─────────────────────────

export const ADMIN = {
  collecting: "⏳ собираю статус…",
  collectFailed: "❌ не вышло собрать статус",
  ymTitle: "Яндекс Музыка",
  ymCollecting: ": собираю статус…",
  ymCollectFailed: ": не вышло собрать статус",
  unavailable: "недоступно",
  broadcastCompose: format`пришли ${bold("одно")} сообщение для рассылки — любой тип (текст, фото, видео, файл, голос, стикер)\n/cancel — отмена`,
  broadcastCancelled: "рассылка отменена",
  broadcastConfirm: (n: number): FormattableString => format`разослать это сообщение ${bold(String(n))} пользователям?`,
  cancelled: "отменено",
  draftStale: "черновик рассылки устарел — начни заново через /broadcast",
  broadcastStarted: "начинаю рассылку…",
  stopping: "останавливаю…",
  notRunning: "рассылка уже не идёт",
  btnBroadcast: "разослать",
  btnCancel: "отмена",
  btnStop: "остановить рассылку",
  btnRefresh: "обновить",
} as const;
