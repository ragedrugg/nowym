import type { SKRSContext2D } from "@napi-rs/canvas";
import { type RGB, rgba } from "./color.ts";
import { roundRectPath } from "./draw.ts";
import type { LyricsBlock } from "./layout.ts";
import { F_BOLD, F_MEDIUM, fontStr, wrapText } from "./text.ts";

/** Рендер кадра анимированных лирик для видеокарточки. activeF — дробный индекс
 * (целая часть = активная строка, дробная = прогресс перехода 0..1). Позиции
 * считаются относительно activeI как нуля, без скользящего окна — это исключает
 * визуальный прыжок при смене activeI. activeF < 0 → режим «до лирики»: строки
 * видны димли, ни одна не подсвечена. */
function drawLyricsAnimFrame(
  ctx: SKRSContext2D,
  x: number,
  maxW: number,
  areaTop: number,
  areaBottom: number,
  anchorY: number,
  lines: string[],
  activeF: number,
  accent: RGB,
  scale: number,
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

  interface AEntry {
    idx: number;
    sz: number;
    fam: string;
    wrapped: string[];
    h: number;
    relPos: number;
    alpha: number;
  }
  const entries: AEntry[] = [];

  entries.push({
    idx: activeI,
    sz: activeSz,
    fam: famOf(activeI),
    wrapped: activeW,
    h: activeH,
    relPos: 0,
    alpha: alphaOf(activeI),
  });
  if (nextI !== activeI) {
    entries.push({
      idx: nextI,
      sz: nextSz,
      fam: famOf(nextI),
      wrapped: nextW,
      h: nextH,
      relPos: nextRelPos,
      alpha: alphaOf(nextI),
    });
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
export function drawLyrics(
  ctx: SKRSContext2D,
  x: number,
  maxW: number,
  areaTop: number,
  areaBottom: number,
  anchorY: number,
  block: LyricsBlock,
  accent: RGB,
  scale = 1,
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

  interface Entry {
    dist: number;
    size: number;
    family: string;
    lh: number;
    wrapped: string[];
    height: number;
  }
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
  for (const e of entries) {
    tops.push(total);
    total += e.height + GAP;
  }
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
