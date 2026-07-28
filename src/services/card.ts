/** Горизонтальная карточка «сейчас играет» (ambient), на @napi-rs/canvas.
 *
 * Компоновка: размытая обложка фоном + затемнение → слева скруглённая обложка
 * с тенью → справа артист, тайтл, Material 3 wavy progress, таймкоды → внизу
 * «от/через». Skia даёт нативный AA, поэтому рисуем волну/маски напрямую
 * с round-caps, без супер-сэмплинга.
 *
 * Стили прогресса: wavy / bar. */
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D, type Image, type Canvas } from "@napi-rs/canvas";
import { getLogger } from "../infra/logging.ts";
import type { CardMeta, CardColors } from "../yandex/types.ts";

const log = getLogger("services.card");

// базовые размеры 16:9 (дефолт) — остальные вычисляются в getLayoutSpec()
const W_DEFAULT = 1600;
const H_DEFAULT = 900;

// на этой ветке assets/ лежит в корне репо — на один "../" меньше, чем при плоской раскладке.
const ASSETS_DIR = path.resolve(import.meta.dirname, "../../assets");
const FONT_DIR = path.join(ASSETS_DIR, "fonts");

// семейства после регистрации
const F_TITLE = "YSMusicHeadline";
const F_BOLD = "YSTextBold";
const F_MEDIUM = "YSTextMedium";
const F_REG = "YSTextRegular";
// фолбэк для CJK — у YS-шрифтов нет этих глифов, без него иероглифы/кана/хангыль
// рендерятся «квадратиками». Подставляется CSS-списком в fontStr, skia сам берёт
// глиф отсюда, если в основном шрифте его нет. Droid (забандлен) покрывает
// японский+китайский; корейский хангыль — отдельным шрифтом (wqy, см. ниже).
const F_CJK = "DroidSansFallback";
const F_CJK_KR = "NowymCjkKorean";
// wqy-zenhei (хангыль) большой (~16MB) и есть в системе — не бандлим, цепляем
// best-effort с системного пути; нет файла → корейский деградирует, ja/zh ок.
const CJK_KR_SYSTEM_PATHS = [
  "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
];

const L = {
  margin: 56,
  coverSize: 540,
  coverRadius: 44,
  textPadLeft: 64,
  textPadRight: 56,
  artistSize: 38,
  titleSize: 84,
  titleSizeMin: 56,
  metaSize: 30,
  metaPadTop: 14,
  explicitBadgeH: 36,
  explicitBadgePad: 14,
  waveHeight: 140,
  waveStroke: 10,
  waveAmplitude: 14,
  waveWavelength: 50,
  inactiveStroke: 6,
  stopRadius: 10,
  timeSize: 30,
  timePadTop: 26,
  badgeSize: 120,
  attrHeight: 76,
  attrAvatarSize: 60,
  attrHandleSize: 36,
  attrLabelSize: 22,
} as const;

let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  GlobalFonts.registerFromPath(path.join(FONT_DIR, "YSMusic-HeadlineBold.ttf"), F_TITLE);
  GlobalFonts.registerFromPath(path.join(FONT_DIR, "YSTextBold.ttf"), F_BOLD);
  GlobalFonts.registerFromPath(path.join(FONT_DIR, "YSTextMedium.ttf"), F_MEDIUM);
  GlobalFonts.registerFromPath(path.join(FONT_DIR, "YSTextRegular.ttf"), F_REG);
  GlobalFonts.registerFromPath(path.join(FONT_DIR, "DroidSansFallback.ttf"), F_CJK);
  for (const p of CJK_KR_SYSTEM_PATHS) {
    try {
      if (fs.existsSync(p) && GlobalFonts.registerFromPath(p, F_CJK_KR)) break;
    } catch {
      /* нет файла / не читается — пропускаем, хангыль деградирует */
    }
  }
  fontsReady = true;
}

// ── раскладки карточки ────────────────────────────────────────────────────────

// поддерживаются только "16:9" (side) и "9:16" (stack) — см. CARD_ASPECTS в
// storage/settings.ts, единственный источник валидации аспекта в системе.
type LayoutMode = "side" | "stack";

interface LayoutSpec {
  mode: LayoutMode;
  W: number;
  H: number;
  coverX: number;
  coverY: number;
  coverSize: number;
  coverRadius: number;
  badgeX: number;
  badgeY: number;
  badgeSize: number;
  attrY: number;
  attrLeft: number;
  attrRight: number;
  textX: number;
  textMaxW: number;
  artistMaxW: number;
  mainTextY: number;  // Y художника (тайтл идёт под ним, см. drawArtistAndTitle)
  artistSize: number;
  titleMaxSize: number;
  titleMinSize: number;
  metaSize: number;
  timeSize: number;
  bgGradDir: "right" | "left" | "bottom";
  waveFixedY?: number;   // только "side": волна привязана к низу обложки
  lyricsScale?: number;  // масштаб шрифтов лирики (default 1.0)
  lyricsTopGap?: number; // отступ от тайтла до области лирики (default 40)
}

function getLayoutSpec(aspect: string): LayoutSpec {
  const m = 56; // margin
  const attrH = L.attrHeight;  // 76
  const attrZoneH = attrH + 16; // 92
  const cr = L.coverRadius;  // 44

  if (aspect === "9:16") {
    const W = 900, H = 1600;
    const attrY = H - m - attrH;  // 1468
    const tw = W - 2 * m;  // 788
    const bsz = 96, bx = W - m - bsz;  // 748
    const csz = tw;  // 788 — полная ширина за вычетом отступов
    return {
      mode: "stack", W, H, coverX: m, coverY: m, coverSize: csz, coverRadius: cr,
      badgeX: bx, badgeY: m, badgeSize: 0, attrY, attrLeft: m, attrRight: W - m,
      textX: m, textMaxW: tw, artistMaxW: tw,
      mainTextY: m + csz + 32,  // 876
      artistSize: 42, titleMaxSize: 84, titleMinSize: 56, metaSize: 32, timeSize: 32,
      bgGradDir: "bottom",
      lyricsScale: 0.85, lyricsTopGap: 20,
    };
  }

  // дефолт: 16:9
  const W = W_DEFAULT, H = H_DEFAULT;
  const coverSize = L.coverSize;  // 540
  const contentBottom = H - attrZoneH;  // 808
  const coverY = Math.round(m + (contentBottom - m - coverSize) / 2);  // 162
  const attrY = H - m - attrH;  // 768
  const bsz = L.badgeSize;  // 120
  const cx = m;
  const tx = cx + coverSize + L.textPadLeft;  // 660
  const tw = W - m - L.textPadRight - tx;     // 828
  const bx = W - m - bsz;                     // 1424
  return {
    mode: "side", W, H, coverX: cx, coverY, coverSize, coverRadius: cr,
    badgeX: bx, badgeY: m, badgeSize: bsz, attrY, attrLeft: m, attrRight: W - m,
    textX: tx, textMaxW: tw, artistMaxW: bx - tx - 24,  // 740
    mainTextY: coverY + 12,
    artistSize: L.artistSize, titleMaxSize: L.titleSize, titleMinSize: L.titleSizeMin,
    metaSize: L.metaSize, timeSize: L.timeSize,
    bgGradDir: "right",
    waveFixedY: coverY + coverSize - (L.waveHeight / 2 + 56),  // 576
  };
}

interface CardToggles {
  album?: boolean;
  type?: boolean;
  year?: boolean;
  label?: boolean;
  track_no?: boolean;
  avatar?: boolean;
}

interface CardOptions {
  style?: string;
  progress?: string; // 'wavy' | 'bar'
  toggles?: CardToggles;
  aspect?: string;      // '16:9' | '9:16'
}

/** Блок лирики на карточке: все строки песни + индекс активной (подсвечиваемой).
 * Когда задан — вместо meta/прогресса/таймкодов рисуется лента строк вокруг
 * активной. activeIndex<0 → центрируем по началу песни.
 * activeFloat — дробный индекс для плавной анимации в видеокарточке:
 *   2.0 = строка 2 полностью активна, 2.6 = 60% перехода 2→3. */
export interface LyricsBlock {
  lines: string[];
  activeIndex: number;
  activeFloat?: number;
  countdownText?: string;  // "3" | "2" | "1"
  countdownAlpha?: number; // 0..1
}

export interface RenderCardArgs {
  coverBytes: Buffer | null;
  title: string;
  artist: string;
  progressMs: number;
  durationMs: number;
  paused?: boolean;
  senderHandle?: string | null;
  senderAvatar?: Buffer | null;
  botUsername?: string | null;
  meta?: Partial<CardMeta>;
  cardOptions?: CardOptions;
  lyrics?: LyricsBlock | null;
  /** при true возвращает сырой RGBA-буфер пикселей вместо JPEG — избегает
   * кодирования/декодирования JPEG на каждый кадр при пайпе в ffmpeg. */
  rawRGBA?: boolean;
}

// ── чистка/композиция заголовка ─────────────────────────────────────────────

// продюсерские/feat-кредиты и видео-теги в названии трека — мусор, режем
const TITLE_JUNK_RE =
  /\s*(?:[([{]\s*(?:prod|produced|feat|ft|featuring)\b[^)\]}]*[)\]}]|[([{]\s*(?:official\s*video|official\s*audio|lyric\s*video|music\s*video|visualizer|audio)\s*[)\]}]|\bprod(?:uced)?\.?\s*by\b.*$|\b(?:feat|ft|featuring)\.?\s+.*$)/gi;

export function cleanTrackTitle(title: string): string {
  let cleaned = title.replace(TITLE_JUNK_RE, " ");
  cleaned = cleaned.replace(/\s{2,}/g, " ").replace(/^[\s\-–—]+|[\s\-–—]+$/g, "");
  return cleaned || title;
}

export function composeTitleWithVersion(title: string, version: string): string {
  if (!version) return title;
  if (title.toLowerCase().includes(version.toLowerCase())) return title;
  const v = version.trim().replace(/^\(+|\)+$/g, "");
  return `${title} (${v})`;
}

// ── цвет ─────────────────────────────────────────────────────────────────────

type RGB = [number, number, number];

function parseHex(value: string | null | undefined): RGB | null {
  if (!value || typeof value !== "string") return null;
  const v = value.trim().replace(/^#/, "");
  if (v.length !== 6) return null;
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return [r, g, b];
}

/** RGB(0-255) → HSV, все компоненты в диапазоне 0-255 (не 0-360/100). */
function rgbToHsv255(r: number, g: number, b: number): [number, number, number] {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  const s = max === 0 ? 0 : d / max;
  return [Math.round(h * 255), Math.round(s * 255), Math.round(max * 255)];
}

/** HSV(0-255) → RGB(0-255). */
function hsv255ToRgb(h: number, s: number, v: number): RGB {
  const hh = (h / 255) * 6;
  const ss = s / 255;
  const vv = v / 255;
  const i = Math.floor(hh) % 6;
  const f = hh - Math.floor(hh);
  const p = vv * (1 - ss);
  const q = vv * (1 - ss * f);
  const t = vv * (1 - ss * (1 - f));
  let r = 0, g = 0, b = 0;
  switch (i) {
    case 0: [r, g, b] = [vv, t, p]; break;
    case 1: [r, g, b] = [q, vv, p]; break;
    case 2: [r, g, b] = [p, vv, t]; break;
    case 3: [r, g, b] = [p, q, vv]; break;
    case 4: [r, g, b] = [t, p, vv]; break;
    default: [r, g, b] = [vv, p, q]; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// max-min < 26 ≈ серый (как ачроматик-порог в metaNeedsWaveColor). Яндекс часто
// отдаёт серый derived accent (#999999) — для него цвет берём с самой обложки.
const ACHROMATIC_MAX_CHROMA = 26;

function isChromatic(c: RGB): boolean {
  return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) >= ACHROMATIC_MAX_CHROMA;
}

/** буст насыщенности/яркости до «неонового» акцента + перевод HSV→RGB. */
function boostHsv(h: number, s: number, v: number): RGB {
  s = Math.max(160, Math.min(255, Math.round(s * 1.4)));
  v = Math.max(220, Math.min(255, v ? Math.round(v * 1.2) : 240));
  return hsv255ToRgb(h, s, v);
}

/** насыщенный яркий акцент для активной волны. Приоритет:
 *  1) хроматичный derived_colors.accent (Яндекс посчитал по обложке);
 *  2) цвет с обложки — среднее HSV по насыщенным пикселям 16×16;
 *  3) брендовый wave только для реально ч/б обложек (нет насыщенных пикселей),
 *     иначе среднее серое — иначе цветные обложки всегда получали бы розовый брендовый акцент. */
function extractAccent(cover: Image, colors: CardColors | undefined): RGB {
  const accent = parseHex(colors?.accent);
  if (accent !== null && isChromatic(accent)) {
    return boostHsv(...rgbToHsv255(accent[0], accent[1], accent[2]));
  }

  const c = createCanvas(16, 16);
  const cx = c.getContext("2d");
  cx.drawImage(cover, 0, 0, 16, 16);
  const data = cx.getImageData(0, 0, 16, 16).data;
  let sumH = 0, sumS = 0, sumV = 0, n = 0;
  let aH = 0, aS = 0, aV = 0, aN = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [ph, ps, pv] = rgbToHsv255(data[i]!, data[i + 1]!, data[i + 2]!);
    aH += ph; aS += ps; aV += pv; aN++;
    if (ps > 60) { sumH += ph; sumS += ps; sumV += pv; n++; }
  }
  if (n > 0) return boostHsv(Math.round(sumH / n), Math.round(sumS / n), Math.round(sumV / n));

  const wave = parseHex(colors?.wave);
  if (wave !== null) return boostHsv(...rgbToHsv255(wave[0], wave[1], wave[2]));
  return boostHsv(Math.round(aH / aN), Math.round(aS / aN), Math.round(aV / aN));
}

function rgba(c: RGB, a: number): string {
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
}

// ── текст ──────────────────────────────────────────────────────────────────

function fontStr(family: string, size: number): string {
  // CJK-фолбэки в CSS-списке: YS → Droid (яп./кит.) → wqy (кор.). Незарегистри-
  // рованное семейство skia просто пропускает, так что список безопасен всегда.
  return `${size}px "${family}", "${F_CJK}", "${F_CJK_KR}"`;
}

function measure(ctx: SKRSContext2D, text: string, family: string, size: number): number {
  ctx.font = fontStr(family, size);
  return ctx.measureText(text).width;
}

function ellipsize(ctx: SKRSContext2D, text: string, family: string, size: number, maxW: number): string {
  if (measure(ctx, text, family, size) <= maxW) return text;
  const ell = "…";
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(ctx, text.slice(0, mid) + ell, family, size) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + ell;
}

/** максимальный шрифт чтобы тайтл влез в строку, шаг 4px. → [size, text]. */
function fitTitleToLine(ctx: SKRSContext2D, text: string, maxSize: number, minSize: number, maxW: number): [number, string] {
  for (let size = maxSize; size >= minSize; size -= 4) {
    if (measure(ctx, text, F_TITLE, size) <= maxW) return [size, text];
  }
  return [minSize, ellipsize(ctx, text, F_TITLE, minSize, maxW)];
}

export function fmtMmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** «альбом «Foo», 2024, 3 из 12» по настройкам toggles. */
function buildMetaLine(ctx: SKRSContext2D, meta: Partial<CardMeta>, toggles: CardToggles, maxW: number, metaSize: number = L.metaSize): string {
  const parts: string[] = [];
  let albumIdx: number | null = null;
  const isSingle = Boolean(meta.is_single);

  const typeRu = toggles.type && meta.type_ru ? meta.type_ru : "";
  const album = toggles.album && !isSingle ? (meta.album || "").trim() : "";

  if (typeRu && album) { albumIdx = parts.length; parts.push(`${typeRu} «${album}»`); }
  else if (typeRu) parts.push(typeRu);
  else if (album) { albumIdx = parts.length; parts.push(`«${album}»`); }

  if (toggles.year && meta.year) parts.push(String(meta.year));
  if (toggles.label && meta.labels?.length) parts.push(meta.labels.join(", "));
  if (toggles.track_no && !isSingle) {
    const n = meta.track_number;
    const total = meta.track_total;
    if (n && total) parts.push(`${n} из ${total}`);
    else if (n) parts.push(`трек ${n}`);
  }

  if (parts.length === 0) return "";
  const sep = ", ";
  const full = parts.join(sep);
  if (measure(ctx, full, F_MEDIUM, metaSize) <= maxW) return full;

  if (albumIdx !== null) {
    const others = [...parts.slice(0, albumIdx), ...parts.slice(albumIdx + 1)];
    const avail = others.length > 0 ? maxW - measure(ctx, others.join(sep) + sep, F_MEDIUM, metaSize) : maxW;
    if (avail > 0) {
      const shrunk = ellipsize(ctx, parts[albumIdx]!, F_MEDIUM, metaSize, avail);
      const candidate = [...parts.slice(0, albumIdx), shrunk, ...parts.slice(albumIdx + 1)].join(sep);
      if (measure(ctx, candidate, F_MEDIUM, metaSize) <= maxW) return candidate;
    }
  }
  return ellipsize(ctx, full, F_MEDIUM, metaSize, maxW);
}

// ── графические примитивы ────────────────────────────────────────────────────

function roundRectPath(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** square-crop обложки в скруглённый прямоугольник с мягкой тенью. */
function drawCoverWithShadow(ctx: SKRSContext2D, cover: Image, x: number, y: number, size: number, radius: number): void {
  // 1) тень — отдельным проходом (clip убил бы её)
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.30)";
  ctx.shadowBlur = 20;
  ctx.shadowOffsetY = 5;
  ctx.fillStyle = "#000";
  roundRectPath(ctx, x, y, size, size, radius);
  ctx.fill();
  ctx.restore();

  // 2) сама обложка, square-crop по центру, в скруглённом клипе
  const s = Math.min(cover.width, cover.height);
  const sx = (cover.width - s) / 2;
  const sy = (cover.height - s) / 2;
  ctx.save();
  roundRectPath(ctx, x, y, size, size, radius);
  ctx.clip();
  ctx.drawImage(cover, sx, sy, s, s, x, y, size, size);
  ctx.restore();
}

/** размытая cover-fit обложка фоном + затемнение + направленный градиент. */
function drawBackground(ctx: SKRSContext2D, cover: Image, W: number, H: number, gradDir: "right" | "left" | "bottom"): void {
  const srcRatio = cover.width / cover.height;
  const dstRatio = W / H;
  let dw: number, dh: number;
  if (srcRatio > dstRatio) { dh = H; dw = H * srcRatio; }
  else { dw = W; dh = W / srcRatio; }
  const dx = (W - dw) / 2;
  const dy = (H - dh) / 2;

  ctx.save();
  ctx.filter = "blur(28px)";
  ctx.drawImage(cover, dx, dy, dw, dh);
  ctx.restore();

  ctx.fillStyle = "rgba(0, 0, 0, 0.373)";
  ctx.fillRect(0, 0, W, H);

  let grad: ReturnType<SKRSContext2D["createLinearGradient"]>;
  if (gradDir === "left") {
    grad = ctx.createLinearGradient(W, 0, 0, 0);
  } else if (gradDir === "bottom") {
    grad = ctx.createLinearGradient(0, 0, 0, H);
  } else {
    grad = ctx.createLinearGradient(0, 0, W, 0);
  }
  grad.addColorStop(0, "rgba(0, 0, 0, 0)");
  grad.addColorStop(1, "rgba(0, 0, 0, 0.431)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
}

/** «!»-маркер откровенного контента в стиле я.музыки — «!» в тонком кольце. */
function drawExplicitMark(ctx: SKRSContext2D, x: number, y: number, d: number): void {
  const col = "rgba(255, 255, 255, 0.92)";
  ctx.save();
  ctx.translate(x, y);
  // кольцо
  const ring = Math.max(2, d * 0.088);
  ctx.strokeStyle = col;
  ctx.lineWidth = ring;
  ctx.beginPath();
  ctx.arc(d / 2, d / 2, (d - ring) / 2, 0, Math.PI * 2);
  ctx.stroke();
  // палочка «!»
  ctx.fillStyle = col;
  const bw = d * 0.118;
  const cx = d / 2;
  roundRectPath(ctx, cx - bw / 2, d * 0.255, bw, d * 0.585 - d * 0.255, bw / 2);
  ctx.fill();
  // точка
  const dotR = bw * 0.6;
  ctx.beginPath();
  ctx.arc(cx, d * 0.715, dotR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** позиция плэйхеда на отрезке [x0, x1] по доле progressMs/durationMs (клэмп 0..1). */
function computePlayX(x0: number, x1: number, progressMs: number, durationMs: number): number {
  const ratio = Math.max(0, Math.min(1, progressMs / durationMs));
  return x0 + (x1 - x0) * ratio;
}

/** Material 3 wavy progress: активная волна const-амплитуды → playhead → inactive прямая. */
function drawWavyProgress(
  ctx: SKRSContext2D, x0: number, x1: number, yc: number,
  progressMs: number, durationMs: number, accent: RGB, paused: boolean,
): void {
  const playX = computePlayX(x0, x1, progressMs, durationMs);

  // inactive часть — от плэйхеда вправо
  if (playX < x1) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.353)"; // 90/255
    ctx.lineWidth = L.inactiveStroke;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(playX, yc);
    ctx.lineTo(x1, yc);
    ctx.stroke();
  }

  // active wavy
  if (playX > x0 + 4) {
    let amp: number = L.waveAmplitude;
    if (paused) amp = Math.max(2, amp / 3);
    const span = playX - x0;
    // n_half снаппится к нечётному (мин 1) — иначе волна втыкается в playhead снизу
    const nRaw = Math.max(1, span / (L.waveWavelength / 2));
    const nHalf = Math.max(1, 2 * Math.round((nRaw - 1) / 2) + 1);
    const effWavelength = (span * 2) / nHalf;
    const omega = (2 * Math.PI) / Math.max(1, effWavelength);

    ctx.strokeStyle = rgba(accent, 1);
    ctx.lineWidth = L.waveStroke;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x0, yc);
    for (let x = x0; x <= playX; x += 2) {
      const y = yc + Math.sin(omega * (x - x0)) * amp;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(playX, yc); // заканчиваем в оси
    ctx.stroke();
  }

  // playhead поверх стыка
  ctx.fillStyle = rgba(accent, 1);
  ctx.beginPath();
  ctx.arc(playX, yc, L.stopRadius, 0, Math.PI * 2);
  ctx.fill();
}

/** прямая полоска: inactive слабая, active accent, playhead-кружок. */
function drawBarProgress(
  ctx: SKRSContext2D, x0: number, x1: number, yc: number,
  progressMs: number, durationMs: number, accent: RGB, paused: boolean,
): void {
  const playX = computePlayX(x0, x1, progressMs, durationMs);
  let activeStroke: number = L.waveStroke;
  if (paused) activeStroke = Math.max(2, activeStroke / 2);

  ctx.lineCap = "round";
  if (playX < x1) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.353)";
    ctx.lineWidth = L.inactiveStroke;
    ctx.beginPath();
    ctx.moveTo(playX, yc);
    ctx.lineTo(x1, yc);
    ctx.stroke();
  }
  if (playX > x0 + 1) {
    ctx.strokeStyle = rgba(accent, 1);
    ctx.lineWidth = activeStroke;
    ctx.beginPath();
    ctx.moveTo(x0, yc);
    ctx.lineTo(playX, yc);
    ctx.stroke();
  }
  ctx.fillStyle = rgba(accent, 1);
  ctx.beginPath();
  ctx.arc(playX, yc, L.stopRadius, 0, Math.PI * 2);
  ctx.fill();
}

/** жадный перенос по словам: строка → визуальные строки, влезающие в maxW.
 * Длинное (за maxLines) сворачивается в последнюю строку с эллипсисом; одиночное
 * слово шире maxW оставляем как есть (редкость). */
function wrapText(
  ctx: SKRSContext2D, text: string, family: string, size: number, maxW: number, maxLines = 2,
): string[] {
  ctx.font = fontStr(family, size);
  if (ctx.measureText(text).width <= maxW) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (!cur || ctx.measureText(candidate).width <= maxW) {
      cur = candidate;
    } else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  if (out.length <= maxLines) return out;
  const head = out.slice(0, maxLines - 1);
  head.push(ellipsize(ctx, out.slice(maxLines - 1).join(" "), family, size, maxW));
  return head;
}

/** Рендер кадра анимированных лирик для видеокарточки. activeF — дробный индекс
 * (целая часть = активная строка, дробная = прогресс перехода 0..1). Позиции
 * считаются относительно activeI как нуля, без скользящего окна — это исключает
 * визуальный прыжок при смене activeI. activeF < 0 → режим «до лирики»: строки
 * видны димли, ни одна не подсвечена. */
function drawLyricsAnimFrame(
  ctx: SKRSContext2D, x: number, maxW: number, areaTop: number, areaBottom: number,
  anchorY: number, lines: string[], activeF: number, accent: RGB, scale: number,
): void {
  if (lines.length === 0) return;

  const ACTIVE_SIZE = Math.round(50 * scale);
  const CTX_SIZE = Math.round(40 * scale);
  const LH = 1.12;
  const GAP = 30;
  const lerp = (a: number, b: number, x: number): number => a + (b - a) * x;

  // activeF < 0: нет активной строки (интро перед лирикой)
  const noHighlight = activeF < 0;
  const rawI = Math.floor(activeF);
  const activeI = noHighlight ? 0 : Math.max(0, Math.min(lines.length - 1, rawI));
  const t = noHighlight ? 0 : Math.max(0, Math.min(1, activeF - rawI));
  const nextI = Math.min(lines.length - 1, activeI + 1);

  const szOf = (i: number): number => {
    if (noHighlight) return CTX_SIZE;
    if (i === activeI) return lerp(ACTIVE_SIZE, CTX_SIZE, t);
    if (i === nextI && i !== activeI) return lerp(CTX_SIZE, ACTIVE_SIZE, t);
    return CTX_SIZE;
  };
  const famOf = (i: number): string => {
    if (!noHighlight && i === activeI) return t < 0.5 ? F_BOLD : F_MEDIUM;
    if (!noHighlight && i === nextI && i !== activeI) return t >= 0.5 ? F_BOLD : F_MEDIUM;
    return F_MEDIUM;
  };
  const alphaOf = (i: number): number => {
    if (noHighlight) return i === 0 ? 0.5 : i === 1 ? 0.4 : 0.3;
    if (i === activeI) return lerp(0.97, 0.4, t);
    if (i === nextI && i !== activeI) return lerp(0.4, 0.97, t);
    return Math.min(Math.abs(i - activeI), Math.abs(i - nextI)) <= 1 ? 0.6 : 0.4;
  };

  // Вычисляем высоты опорных строк (active и next) для позиционирования камеры
  const activeSz = szOf(activeI);
  const activeW = wrapText(ctx, lines[activeI]!, famOf(activeI), Math.round(activeSz), maxW);
  const activeH = activeW.length * activeSz * LH;

  const nextSz = szOf(nextI);
  const nextW = nextI !== activeI ? wrapText(ctx, lines[nextI]!, famOf(nextI), Math.round(nextSz), maxW) : activeW;
  const nextH = nextI !== activeI ? nextW.length * nextSz * LH : activeH;
  const nextRelPos = activeH + GAP; // relPos nextI относительно activeI=0

  // Камера: плавно движется от центра activeI к центру nextI
  const camY = lerp(activeH / 2, nextRelPos + nextH / 2, t);

  interface AEntry { idx: number; sz: number; fam: string; wrapped: string[]; h: number; relPos: number; alpha: number }
  const entries: AEntry[] = [];

  entries.push({ idx: activeI, sz: activeSz, fam: famOf(activeI), wrapped: activeW, h: activeH, relPos: 0, alpha: alphaOf(activeI) });
  if (nextI !== activeI) {
    entries.push({ idx: nextI, sz: nextSz, fam: famOf(nextI), wrapped: nextW, h: nextH, relPos: nextRelPos, alpha: alphaOf(nextI) });
  }

  // Расширяем вниз от nextI+1
  let downPos = nextRelPos + nextH + GAP;
  for (let i = nextI + 1; i < lines.length; i++) {
    if (anchorY + downPos - camY > areaBottom + 10) break;
    const w = wrapText(ctx, lines[i]!, F_MEDIUM, Math.round(CTX_SIZE), maxW);
    const h = w.length * CTX_SIZE * LH;
    entries.push({ idx: i, sz: CTX_SIZE, fam: F_MEDIUM, wrapped: w, h, relPos: downPos, alpha: alphaOf(i) });
    downPos += h + GAP;
  }

  // Расширяем вверх от activeI-1
  let upPos = 0;
  for (let i = activeI - 1; i >= 0; i--) {
    const w = wrapText(ctx, lines[i]!, F_MEDIUM, Math.round(CTX_SIZE), maxW);
    const h = w.length * CTX_SIZE * LH;
    upPos -= h + GAP;
    if (anchorY + upPos + h - camY < areaTop - 10) break;
    entries.push({ idx: i, sz: CTX_SIZE, fam: F_MEDIUM, wrapped: w, h, relPos: upPos, alpha: alphaOf(i) });
  }

  if (!noHighlight) {
    for (const e of entries) {
      const top = anchorY + e.relPos - camY;
      if (e.idx === activeI && t < 1) {
        ctx.fillStyle = rgba(accent, 1 - t);
        roundRectPath(ctx, x - 22, top + 2, 6, e.h - 4, 3);
        ctx.fill();
      } else if (e.idx === nextI && nextI !== activeI && t > 0) {
        ctx.fillStyle = rgba(accent, t);
        roundRectPath(ctx, x - 22, top + 2, 6, e.h - 4, 3);
        ctx.fill();
      }
    }
  }

  ctx.textBaseline = "top";
  for (const e of entries) {
    const top = anchorY + e.relPos - camY;
    if (top + e.h < areaTop - 6 || top > areaBottom + 6) continue;
    ctx.fillStyle = `rgba(255, 255, 255, ${e.alpha.toFixed(3)})`;
    ctx.font = fontStr(e.fam, Math.round(e.sz));
    for (let j = 0; j < e.wrapped.length; j++) {
      ctx.fillText(e.wrapped[j]!, x, top + j * e.sz * LH);
    }
  }
}

/** лента строк лирики вокруг активной: активная — крупно/ярко + accent-риска
 * слева, соседние мельче и приглушены. Длинные строки переносятся (до 2 виз.
 * строк), а не режутся. Активная центрируется по вертикали области. Таймкоды
 * не рисуем — тайминг выражен тем, какая строка подсвечена. */
function drawLyrics(
  ctx: SKRSContext2D, x: number, maxW: number, areaTop: number, areaBottom: number,
  anchorY: number, block: LyricsBlock, accent: RGB, scale = 1,
): void {
  const lines = block.lines;
  if (lines.length === 0) return;

  // анимированный путь: всегда использовать drawLyricsAnimFrame при видео-рендере (activeFloat),
  // чтобы hold- и transition-кадры рендерились одним кодом без визуального прыжка
  if (block.activeFloat !== undefined) {
    drawLyricsAnimFrame(ctx, x, maxW, areaTop, areaBottom, anchorY, lines, block.activeFloat, accent, scale);
    return;
  }

  const activeRaw = block.activeIndex;
  const active = Math.max(0, Math.min(lines.length - 1, activeRaw < 0 ? 0 : activeRaw));

  const ACTIVE_SIZE = Math.round(50 * scale);
  const CTX_SIZE = Math.round(40 * scale);
  const LH = 1.12; // межстрочный коэффициент внутри одной (переносимой) строки
  const GAP = 30; // постоянный отступ между РАЗНЫМИ лирик-строками

  // окно всегда из 3 логических строк (или сколько есть): обычно предыдущая+активная+
  // следующая, но на краю сдвигается — первая строка → активная + 2 следующих,
  // последняя → 2 предыдущих + активная.
  const WINDOW = Math.min(3, lines.length);
  let start = active - 1;
  if (start < 0) start = 0;
  if (start + WINDOW > lines.length) start = lines.length - WINDOW;
  const end = start + WINDOW;

  interface Entry { dist: number; size: number; family: string; lh: number; wrapped: string[]; height: number }
  const entries: Entry[] = [];
  for (let i = start; i < end; i++) {
    const dist = Math.abs(i - active);
    const size = dist === 0 ? ACTIVE_SIZE : CTX_SIZE;
    const family = dist === 0 ? F_BOLD : F_MEDIUM;
    const wrapped = wrapText(ctx, lines[i]!, family, size, maxW);
    const lh = size * LH;
    entries.push({ dist, size, family, lh, wrapped, height: wrapped.length * lh });
  }
  if (entries.length === 0) return;

  // стопка: высота блока + постоянный GAP между блоками.
  const tops: number[] = [];
  let total = 0;
  for (const e of entries) { tops.push(total); total += e.height + GAP; }
  const aPos = active - start;
  const lastIdx = entries.length - 1;

  // центр активной строки якорим к anchorY (центр обложки), затем клэмпим, чтобы блок
  // не залез в тайтл сверху и не вывалился за низ области.
  const activeCenter = tops[aPos]! + entries[aPos]!.height / 2;
  let shift = anchorY - activeCenter;
  const blockTop = tops[0]! + shift;
  const blockBottom = tops[lastIdx]! + entries[lastIdx]!.height + shift;
  if (blockTop < areaTop) shift += areaTop - blockTop;
  else if (blockBottom > areaBottom) shift -= blockBottom - areaBottom;

  ctx.textBaseline = "top";
  for (let k = 0; k < entries.length; k++) {
    const e = entries[k]!;
    const top = tops[k]! + shift;
    if (top + e.height < areaTop - 6 || top > areaBottom + 6) continue;
    if (e.dist === 0) {
      // accent-риска слева во всю высоту активной строки.
      ctx.fillStyle = rgba(accent, 1);
      roundRectPath(ctx, x - 22, top + 2, 6, e.height - 4, 3);
      ctx.fill();
      ctx.fillStyle = "rgba(255, 255, 255, 0.97)";
    } else {
      ctx.fillStyle = `rgba(255, 255, 255, ${e.dist === 1 ? 0.6 : 0.4})`;
    }
    ctx.font = fontStr(e.family, e.size);
    for (let j = 0; j < e.wrapped.length; j++) {
      ctx.fillText(e.wrapped[j]!, x, top + j * e.lh);
    }
  }
}

/** круглый аватар из байт. */
async function drawRoundAvatar(ctx: SKRSContext2D, avatarBytes: Buffer, x: number, y: number, size: number): Promise<void> {
  const img = await loadImage(avatarBytes);
  const s = Math.min(img.width, img.height);
  const sx = (img.width - s) / 2;
  const sy = (img.height - s) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, sx, sy, s, s, x, y, size, size);
  ctx.restore();
}

/** нижняя полоса: «@юзер / от» слева, «@bot / через» справа. */
async function drawAttribution(
  ctx: SKRSContext2D, y: number, xLeft: number, xRight: number,
  senderHandle: string | null, senderAvatar: Buffer | null, botUsername: string | null,
): Promise<void> {
  const handleSize = L.attrHandleSize;
  const labelSize = L.attrLabelSize;
  const avSize = L.attrAvatarSize;
  const textTop = y + 6;
  const textBot = y + 6 + handleSize + 4;
  ctx.textBaseline = "top";

  // слева
  let curX = xLeft;
  if (senderHandle) {
    if (senderAvatar) {
      try {
        await drawRoundAvatar(ctx, senderAvatar, curX, y + (L.attrHeight - avSize) / 2, avSize);
        curX += avSize + 16;
      } catch (e) {
        log.debug(`avatar render skipped: ${e}`);
      }
    }
    ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
    ctx.font = fontStr(F_BOLD, handleSize);
    ctx.fillText(senderHandle, curX, textTop);
    ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
    ctx.font = fontStr(F_REG, labelSize);
    ctx.fillText("от", curX, textBot);
  }

  // справа, по правому краю
  if (botUsername) {
    const botHandle = "@" + botUsername.replace(/^@/, "");
    ctx.font = fontStr(F_BOLD, handleSize);
    const bw = ctx.measureText(botHandle).width;
    ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
    ctx.fillText(botHandle, xRight - bw, textTop);
    ctx.font = fontStr(F_REG, labelSize);
    const lw = ctx.measureText("через").width;
    ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
    ctx.fillText("через", xRight - lw, textBot);
  }
}

/** артист + тайтл (+explicit-бейдж), каскадом от artistY (тайтл — под артистом).
 * Возвращает titleSize — нужен вызывающему для вёрстки meta/лирики под тайтлом. */
function drawArtistAndTitle(
  ctx: SKRSContext2D, lay: LayoutSpec, artist: string, displayTitle: string,
  badgeW: number, explicit: boolean, artistY: number, titleY: number, artistMaxW: number,
): number {
  const artistText = ellipsize(ctx, artist, F_MEDIUM, lay.artistSize, artistMaxW);
  ctx.fillStyle = "rgba(255, 255, 255, 0.784)";
  ctx.font = fontStr(F_MEDIUM, lay.artistSize);
  ctx.fillText(artistText, lay.textX, artistY);

  const [titleSize, titleText] = fitTitleToLine(ctx, displayTitle, lay.titleMaxSize, lay.titleMinSize, Math.max(0, lay.textMaxW - badgeW));
  ctx.fillStyle = "rgba(255, 255, 255, 0.961)";
  ctx.font = fontStr(F_TITLE, titleSize);
  ctx.fillText(titleText, lay.textX, titleY);
  if (explicit) {
    const bx = lay.textX + ctx.measureText(titleText).width + L.explicitBadgePad;
    drawExplicitMark(ctx, bx, titleY + titleSize * 0.46 - L.explicitBadgeH / 2, L.explicitBadgeH);
  }
  return titleSize;
}

function paintMetaText(ctx: SKRSContext2D, lay: LayoutSpec, text: string, y: number): void {
  ctx.fillStyle = "rgba(255, 255, 255, 0.686)";
  ctx.font = fontStr(F_MEDIUM, lay.metaSize);
  ctx.fillText(text, lay.textX, y);
}

// ── публичный API ────────────────────────────────────────────────────────────

const FALLBACK_BG: RGB = [40, 44, 56];

// LRU-1: кэшируем последнюю декодированную обложку по sha1-хэшу байт.
// Критично для видео: 60+ кадров одной обложки → decode только 1 раз.
let _coverCacheKey: string | null = null;
let _coverCacheVal: Image | null = null;

// фолбэк — константа (мягкий тёмный фон 1000×1000), рендерим и энкодим один
// раз за процесс, а не на каждый рендер карточки без обложки.
let _fallbackCoverPromise: Promise<Image> | null = null;
function buildFallbackCover(): Promise<Image> {
  if (_fallbackCoverPromise === null) {
    _fallbackCoverPromise = (async () => {
      const c = createCanvas(1000, 1000);
      const cx = c.getContext("2d");
      cx.fillStyle = rgba(FALLBACK_BG, 1);
      cx.fillRect(0, 0, 1000, 1000);
      return (await loadImage(await c.encode("png"))) as Image;
    })();
  }
  return _fallbackCoverPromise;
}

async function loadCover(coverBytes: Buffer | null): Promise<Image> {
  if (coverBytes) {
    const key = createHash("sha1").update(coverBytes).digest("base64");
    if (key === _coverCacheKey && _coverCacheVal !== null) return _coverCacheVal;
    try {
      const img = await loadImage(coverBytes);
      _coverCacheKey = key;
      _coverCacheVal = img;
      return img;
    } catch (e) {
      log.warning(`не распарсил обложку: ${e}`);
    }
  }
  return buildFallbackCover();
}

// mark.svg — векторный путь даёт честный AA без блюра на тонких лучах спарка,
// в отличие от даунскейла растрового 512px. Суперсэмплим 4× и ужимаем в badgeSize, кэшируем канвас.
let markCanvas: Canvas | null = null;
async function getBrandMark(): Promise<Canvas | null> {
  if (markCanvas === null) {
    try {
      const svg = await loadImage(fs.readFileSync(path.join(ASSETS_DIR, "mark.svg")));
      const ss = L.badgeSize * 4; // суперсэмплинг
      const hi = createCanvas(ss, ss);
      const h = hi.getContext("2d");
      h.imageSmoothingEnabled = true;
      h.imageSmoothingQuality = "high";
      h.drawImage(svg, 0, 0, ss, ss);
      const off = createCanvas(L.badgeSize, L.badgeSize);
      const o = off.getContext("2d");
      o.imageSmoothingEnabled = true;
      o.imageSmoothingQuality = "high";
      o.drawImage(hi, 0, 0, L.badgeSize, L.badgeSize);
      markCanvas = off;
    } catch (e) {
      log.debug(`brand mark не загружен: ${e}`);
      return null;
    }
  }
  return markCanvas;
}

/** JPEG-байты карточки. На кривой вход не валится. */
export async function renderNowPlayingCard(args: RenderCardArgs): Promise<Buffer> {
  ensureFonts();
  const title = cleanTrackTitle((args.title || "").trim()) || "—";
  const artist = (args.artist || "").trim() || "Unknown";
  const durationMs = Math.max(1, Math.floor(args.durationMs || 1));
  const progressMs = Math.min(Math.max(0, Math.floor(args.progressMs || 0)), durationMs);
  const paused = Boolean(args.paused);
  const meta: Partial<CardMeta> = args.meta ?? {};
  const cardOptions = args.cardOptions ?? {};
  const toggles = cardOptions.toggles ?? {};
  const progressStyle = cardOptions.progress || "wavy";
  const lyrics = args.lyrics ?? null;

  const lay = getLayoutSpec(cardOptions.aspect ?? "16:9");

  const cover = await loadCover(args.coverBytes);
  const accent = extractAccent(cover, meta.colors);

  const canvas = createCanvas(lay.W, lay.H);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  drawBackground(ctx, cover, lay.W, lay.H, lay.bgGradDir);
  drawCoverWithShadow(ctx, cover, lay.coverX, lay.coverY, lay.coverSize, lay.coverRadius);

  const mark = await getBrandMark();
  if (mark && lay.badgeSize > 0) ctx.drawImage(mark, lay.badgeX, lay.badgeY, lay.badgeSize, lay.badgeSize);

  ctx.textBaseline = "top";
  const displayTitle = composeTitleWithVersion(title, meta.version || "");
  const explicit = Boolean(meta.explicit);
  const badgeW = explicit ? L.explicitBadgeH + L.explicitBadgePad : 0;

  const drawProgressAndTime = (x0: number, maxW: number, waveYCenter: number): void => {
    const x1 = x0 + maxW;
    if (progressStyle === "bar") {
      drawBarProgress(ctx, x0, x1, waveYCenter, progressMs, durationMs, accent, paused);
    } else {
      drawWavyProgress(ctx, x0, x1, waveYCenter, progressMs, durationMs, accent, paused);
    }
    const timeY = waveYCenter + L.waveHeight / 2 + L.timePadTop;
    ctx.font = fontStr(F_REG, lay.timeSize);
    ctx.textBaseline = "top";
    ctx.fillStyle = "rgba(255, 255, 255, 0.863)";
    ctx.fillText(fmtMmss(progressMs), x0, timeY);
    const total = fmtMmss(durationMs);
    const totalW = ctx.measureText(total).width;
    ctx.fillStyle = "rgba(255, 255, 255, 0.627)";
    ctx.fillText(total, x1 - totalW, timeY);
  };

  const titleY = lay.mainTextY + lay.artistSize + 18;
  const titleSize = drawArtistAndTitle(ctx, lay, artist, displayTitle, badgeW, explicit, lay.mainTextY, titleY, lay.artistMaxW);
  const isSide = lay.mode === "side";

  if (lyrics && lyrics.lines.length > 0) {
    const areaTop = titleY + titleSize + (lay.lyricsTopGap ?? 40);
    const areaBottom = isSide ? lay.coverY + lay.coverSize : lay.attrY - 20;
    const anchorY = isSide ? lay.coverY + lay.coverSize / 2 : (areaTop + areaBottom) / 2;
    drawLyrics(ctx, lay.textX, lay.textMaxW, areaTop, areaBottom, anchorY, lyrics, accent, lay.lyricsScale ?? 1);
  } else if (isSide) {
    // side: прогресс на фиксированной Y (waveFixedY привязана к низу обложки),
    // не зависит от того, нарисована ли meta-строка — в отличие от stack.
    const metaText = buildMetaLine(ctx, meta, toggles, lay.textMaxW, lay.metaSize);
    if (metaText) paintMetaText(ctx, lay, metaText, titleY + titleSize + L.metaPadTop);
    drawProgressAndTime(lay.textX, lay.textMaxW, lay.waveFixedY!);
  } else {
    // stack: как side, но прогресс каскадом от низа meta (или тайтла, если её нет),
    // а не на фиксированной Y — под текстом ниже нет соседей, что нарисовали, туда и едем.
    let curY = titleY + titleSize;
    const metaText = buildMetaLine(ctx, meta, toggles, lay.textMaxW, lay.metaSize);
    if (metaText) {
      const metaY = curY + L.metaPadTop;
      paintMetaText(ctx, lay, metaText, metaY);
      curY = metaY + lay.metaSize;
    }
    drawProgressAndTime(lay.textX, lay.textMaxW, curY + 16 + L.waveHeight / 2);
  }

  await drawAttribution(
    ctx, lay.attrY, lay.attrLeft, lay.attrRight,
    args.senderHandle ?? null, args.senderAvatar ?? null, args.botUsername ?? null,
  );

  if (args.rawRGBA) return canvas.data();
  return canvas.encode("jpeg", 92);
}
