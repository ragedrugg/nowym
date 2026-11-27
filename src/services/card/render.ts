import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import type { CardMeta } from "../../yandex/types.ts";
import { drawAttribution, getBrandMark, loadCover } from "./assets.ts";
import { extractAccent } from "./color.ts";
import { drawBackground, drawBarProgress, drawCoverWithShadow, drawWavyProgress } from "./draw.ts";
import { getLayoutSpec, L, type LayoutSpec, type RenderCardArgs } from "./layout.ts";
import { drawLyrics } from "./lyrics.ts";
import {
  buildMetaLine,
  cleanTrackTitle,
  composeTitleWithVersion,
  ellipsize,
  ensureFonts,
  F_MEDIUM,
  F_REG,
  F_TITLE,
  fitTitleToLine,
  fmtMmss,
  fontStr,
} from "./text.ts";

/** артист + тайтл, каскадом от artistY (тайтл — под артистом).
 * Возвращает titleSize — нужен вызывающему для вёрстки meta/лирики под тайтлом. */
function drawArtistAndTitle(
  ctx: SKRSContext2D,
  lay: LayoutSpec,
  artist: string,
  displayTitle: string,
  artistY: number,
  titleY: number,
  artistMaxW: number,
): number {
  const artistText = ellipsize(ctx, artist, F_MEDIUM, lay.artistSize, artistMaxW);
  ctx.fillStyle = "rgba(255, 255, 255, 0.784)";
  ctx.font = fontStr(F_MEDIUM, lay.artistSize);
  ctx.fillText(artistText, lay.textX, artistY);

  const [titleSize, titleText] = fitTitleToLine(ctx, displayTitle, lay.titleMaxSize, lay.titleMinSize, lay.textMaxW);
  ctx.fillStyle = "rgba(255, 255, 255, 0.961)";
  ctx.font = fontStr(F_TITLE, titleSize);
  ctx.fillText(titleText, lay.textX, titleY);
  return titleSize;
}

function paintMetaText(ctx: SKRSContext2D, lay: LayoutSpec, text: string, y: number): void {
  ctx.fillStyle = "rgba(255, 255, 255, 0.686)";
  ctx.font = fontStr(F_MEDIUM, lay.metaSize);
  ctx.fillText(text, lay.textX, y);
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
  // high — для даунскейла обложки и аватара; «low» (выигрыш R5) выставляет только drawBackground у себя.
  ctx.imageSmoothingQuality = "high";

  drawBackground(ctx, cover, lay.W, lay.H, lay.bgGradDir);
  drawCoverWithShadow(ctx, cover, lay.coverX, lay.coverY, lay.coverSize, lay.coverRadius);

  const mark = await getBrandMark();
  if (mark && lay.badgeSize > 0) ctx.drawImage(mark, lay.badgeX, lay.badgeY, lay.badgeSize, lay.badgeSize);

  ctx.textBaseline = "top";
  const displayTitle = composeTitleWithVersion(title, meta.version || "");

  const drawProgressAndTime = (x0: number, maxW: number, waveYCenter: number): void => {
    if (args.hideProgress) return;
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
  const titleSize = drawArtistAndTitle(ctx, lay, artist, displayTitle, lay.mainTextY, titleY, lay.artistMaxW);
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
    ctx,
    lay.attrY,
    lay.attrLeft,
    lay.attrRight,
    args.senderHandle ?? null,
    args.senderAvatar ?? null,
    args.botUsername ?? null,
  );

  if (args.rawRGBA) return canvas.data();
  return canvas.encode("jpeg", 92);
}
