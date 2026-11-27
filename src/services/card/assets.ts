import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Canvas, createCanvas, type Image, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import { getLogger } from "../../infra/logging.ts";
import { type RGB, rgba } from "./color.ts";
import { L } from "./layout.ts";
import { ASSETS_DIR, F_BOLD, F_REG, fontStr } from "./text.ts";

const log = getLogger("services.card");

/** круглый аватар из байт. */
async function drawRoundAvatar(
  ctx: SKRSContext2D,
  avatarBytes: Buffer,
  x: number,
  y: number,
  size: number,
): Promise<void> {
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
export async function drawAttribution(
  ctx: SKRSContext2D,
  y: number,
  xLeft: number,
  xRight: number,
  senderHandle: string | null,
  senderAvatar: Buffer | null,
  botUsername: string | null,
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

export async function loadCover(coverBytes: Buffer | null): Promise<Image> {
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
export async function getBrandMark(): Promise<Canvas | null> {
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
