import fs from "node:fs";
import path from "node:path";
import { GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import type { CardMeta } from "../../yandex/types.ts";
import { type CardToggles, L } from "./layout.ts";

// assets/ лежит в корне репо (этот файл — src/services/card/).
export const ASSETS_DIR = path.resolve(import.meta.dirname, "../../../assets");
const FONT_DIR = path.join(ASSETS_DIR, "fonts");

// семейства после регистрации
export const F_TITLE = "YSMusicHeadline";
export const F_BOLD = "YSTextBold";
export const F_MEDIUM = "YSTextMedium";
export const F_REG = "YSTextRegular";
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

let fontsReady = false;
export function ensureFonts(): void {
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

// ── текст ──────────────────────────────────────────────────────────────────

export function fontStr(family: string, size: number): string {
  // CJK-фолбэки в CSS-списке: YS → Droid (яп./кит.) → wqy (кор.). Незарегистри-
  // рованное семейство skia просто пропускает, так что список безопасен всегда.
  return `${size}px "${family}", "${F_CJK}", "${F_CJK_KR}"`;
}

function measure(ctx: SKRSContext2D, text: string, family: string, size: number): number {
  ctx.font = fontStr(family, size);
  return ctx.measureText(text).width;
}

export function ellipsize(ctx: SKRSContext2D, text: string, family: string, size: number, maxW: number): string {
  if (measure(ctx, text, family, size) <= maxW) return text;
  const ell = "…";
  let lo = 0,
    hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(ctx, text.slice(0, mid) + ell, family, size) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + ell;
}

/** максимальный шрифт чтобы тайтл влез в строку, шаг 4px. → [size, text]. */
export function fitTitleToLine(
  ctx: SKRSContext2D,
  text: string,
  maxSize: number,
  minSize: number,
  maxW: number,
): [number, string] {
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
export function buildMetaLine(
  ctx: SKRSContext2D,
  meta: Partial<CardMeta>,
  toggles: CardToggles,
  maxW: number,
  metaSize: number = L.metaSize,
): string {
  const parts: string[] = [];
  let albumIdx: number | null = null;
  const isSingle = Boolean(meta.is_single);

  const typeRu = toggles.type && meta.type_ru ? meta.type_ru : "";
  const album = toggles.album && !isSingle ? (meta.album || "").trim() : "";

  if (typeRu && album) {
    albumIdx = parts.length;
    parts.push(`${typeRu} «${album}»`);
  } else if (typeRu) parts.push(typeRu);
  else if (album) {
    albumIdx = parts.length;
    parts.push(`«${album}»`);
  }

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

/** жадный перенос по словам: строка → визуальные строки, влезающие в maxW.
 * Длинное (за maxLines) сворачивается в последнюю строку с эллипсисом; одиночное
 * слово шире maxW оставляем как есть (редкость). */
export function wrapText(
  ctx: SKRSContext2D,
  text: string,
  family: string,
  size: number,
  maxW: number,
  maxLines = 2,
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
