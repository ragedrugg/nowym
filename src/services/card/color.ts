import { createCanvas, type Image } from "@napi-rs/canvas";
import type { CardColors } from "../../yandex/types.ts";

// ── цвет ─────────────────────────────────────────────────────────────────────

export type RGB = [number, number, number];

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
  const rr = r / 255,
    gg = g / 255,
    bb = b / 255;
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
  let r = 0,
    g = 0,
    b = 0;
  switch (i) {
    case 0:
      [r, g, b] = [vv, t, p];
      break;
    case 1:
      [r, g, b] = [q, vv, p];
      break;
    case 2:
      [r, g, b] = [p, vv, t];
      break;
    case 3:
      [r, g, b] = [p, q, vv];
      break;
    case 4:
      [r, g, b] = [t, p, vv];
      break;
    default:
      [r, g, b] = [vv, p, q];
      break;
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
export function extractAccent(cover: Image, colors: CardColors | undefined): RGB {
  const accent = parseHex(colors?.accent);
  if (accent !== null && isChromatic(accent)) {
    return boostHsv(...rgbToHsv255(accent[0], accent[1], accent[2]));
  }

  const c = createCanvas(16, 16);
  const cx = c.getContext("2d");
  cx.drawImage(cover, 0, 0, 16, 16);
  const data = cx.getImageData(0, 0, 16, 16).data;
  let sumH = 0,
    sumS = 0,
    sumV = 0,
    n = 0;
  let aH = 0,
    aS = 0,
    aV = 0,
    aN = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [ph, ps, pv] = rgbToHsv255(data[i]!, data[i + 1]!, data[i + 2]!);
    aH += ph;
    aS += ps;
    aV += pv;
    aN++;
    if (ps > 60) {
      sumH += ph;
      sumS += ps;
      sumV += pv;
      n++;
    }
  }
  if (n > 0) return boostHsv(Math.round(sumH / n), Math.round(sumS / n), Math.round(sumV / n));

  const wave = parseHex(colors?.wave);
  if (wave !== null) return boostHsv(...rgbToHsv255(wave[0], wave[1], wave[2]));
  return boostHsv(Math.round(aH / aN), Math.round(aS / aN), Math.round(aV / aN));
}

export function rgba(c: RGB, a: number): string {
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
}
