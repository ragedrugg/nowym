import { createCanvas, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { type RGB, rgba } from "./color.ts";
import { L } from "./layout.ts";

// ── графические примитивы ────────────────────────────────────────────────────

export function roundRectPath(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** square-crop обложки в скруглённый прямоугольник с мягкой тенью. */
export function drawCoverWithShadow(
  ctx: SKRSContext2D,
  cover: Image,
  x: number,
  y: number,
  size: number,
  radius: number,
): void {
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

const BG_BLUR_PX = 28;
const BG_DOWNSCALE = 4;

/** размытая cover-fit обложка фоном + затемнение + направленный градиент (export — для теста R5). */
export function drawBackground(
  ctx: SKRSContext2D,
  cover: Image,
  W: number,
  H: number,
  gradDir: "right" | "left" | "bottom",
): void {
  const srcRatio = cover.width / cover.height;
  const dstRatio = W / H;
  let dw: number, dh: number;
  if (srcRatio > dstRatio) {
    dh = H;
    dw = H * srcRatio;
  } else {
    dw = W;
    dh = W / srcRatio;
  }
  const dx = (W - dw) / 2;
  const dy = (H - dh) / 2;

  // R5: blur(28px) на полном размере — самый дорогой шаг фона (~8 из ~11 мс).
  // Размываем на канвасе 1/BG_DOWNSCALE с пропорциональным радиусом и растягиваем:
  // после такого блюра высоких частот нет, разница с полноразмерным в пределах
  // 6/255 на канал (сверка до/после на 8 эталонах — progress.md, Phase 2).
  const sw = Math.ceil(W / BG_DOWNSCALE);
  const sh = Math.ceil(H / BG_DOWNSCALE);
  const small = createCanvas(sw, sh);
  const sctx = small.getContext("2d");
  sctx.filter = `blur(${BG_BLUR_PX / BG_DOWNSCALE}px)`;
  sctx.drawImage(cover, dx / BG_DOWNSCALE, dy / BG_DOWNSCALE, dw / BG_DOWNSCALE, dh / BG_DOWNSCALE);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "low";
  ctx.drawImage(small, 0, 0, sw * BG_DOWNSCALE, sh * BG_DOWNSCALE);
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

/** позиция плэйхеда на отрезке [x0, x1] по доле progressMs/durationMs (клэмп 0..1). */
function computePlayX(x0: number, x1: number, progressMs: number, durationMs: number): number {
  const ratio = Math.max(0, Math.min(1, progressMs / durationMs));
  return x0 + (x1 - x0) * ratio;
}

/** Material 3 wavy progress: активная волна const-амплитуды → playhead → inactive прямая. */
export function drawWavyProgress(
  ctx: SKRSContext2D,
  x0: number,
  x1: number,
  yc: number,
  progressMs: number,
  durationMs: number,
  accent: RGB,
  paused: boolean,
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
export function drawBarProgress(
  ctx: SKRSContext2D,
  x0: number,
  x1: number,
  yc: number,
  progressMs: number,
  durationMs: number,
  accent: RGB,
  paused: boolean,
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
