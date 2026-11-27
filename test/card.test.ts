/** Карточка: чистые хелперы + smoke-рендер (валидный JPEG). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createCanvas, type Image } from "@napi-rs/canvas";
import {
  cleanTrackTitle,
  composeTitleWithVersion,
  drawBackground,
  fmtMmss,
  renderNowPlayingCard,
} from "../src/services/card.ts";

test("cleanTrackTitle — режет prod/feat/видео-теги", () => {
  assert.equal(cleanTrackTitle("Song (prod. by X)"), "Song");
  assert.equal(cleanTrackTitle("Song feat. Someone"), "Song");
  assert.equal(cleanTrackTitle("Song (Official Video)"), "Song");
  assert.equal(cleanTrackTitle("Чистый Трек"), "Чистый Трек");
  assert.equal(cleanTrackTitle(""), ""); // пусто → пусто (fallback на «—» в рендере)
});

test("composeTitleWithVersion", () => {
  assert.equal(composeTitleWithVersion("Song", ""), "Song");
  assert.equal(composeTitleWithVersion("Song", "Remix"), "Song (Remix)");
  assert.equal(composeTitleWithVersion("Song (Remix)", "Remix"), "Song (Remix)"); // дубль
  assert.equal(composeTitleWithVersion("Song", "(Live)"), "Song (Live)"); // скобки снимаются
});

test("fmtMmss", () => {
  assert.equal(fmtMmss(95_000), "1:35");
  assert.equal(fmtMmss(217_000), "3:37");
  assert.equal(fmtMmss(0), "0:00");
});

test("renderNowPlayingCard — валидный JPEG даже без обложки", async () => {
  const jpeg = await renderNowPlayingCard({
    coverBytes: null,
    title: "Трек",
    artist: "Артист",
    progressMs: 30_000,
    durationMs: 180_000,
    botUsername: "nowymbot",
  });
  assert.ok(jpeg.length > 1000, "непустой JPEG");
  assert.equal(jpeg[0], 0xff); // JPEG SOI
  assert.equal(jpeg[1], 0xd8);
});

test("R5: фон с блюром на канвасе 1/4 почти совпадает с полноразмерным blur(28px)", () => {
  // контрастная «обложка»: шахматка 50px + надпись — худший случай для даунскейла
  const cover = createCanvas(1000, 1000);
  const cx = cover.getContext("2d");
  for (let i = 0; i < 20; i++)
    for (let j = 0; j < 20; j++) {
      cx.fillStyle = (i + j) % 2 ? "#ff2050" : "#10e0ff";
      cx.fillRect(i * 50, j * 50, 50, 50);
    }
  cx.fillStyle = "#fff";
  cx.font = "bold 160px sans-serif";
  cx.fillText("TEST", 200, 560);

  for (const [W, H, dir] of [
    [1600, 900, "right"],
    [900, 1600, "bottom"],
  ] as const) {
    const got = createCanvas(W, H);
    drawBackground(got.getContext("2d"), cover as unknown as Image, W, H, dir);

    // эталон — прежний алгоритм: blur(28px) на полном размере + те же затемнение/градиент
    const ref = createCanvas(W, H);
    const rx = ref.getContext("2d");
    const dw = Math.max(W, H);
    rx.filter = "blur(28px)";
    rx.drawImage(cover, (W - dw) / 2, (H - dw) / 2, dw, dw);
    rx.filter = "none";
    rx.fillStyle = "rgba(0, 0, 0, 0.373)";
    rx.fillRect(0, 0, W, H);
    const grad = dir === "bottom" ? rx.createLinearGradient(0, 0, 0, H) : rx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, "rgba(0, 0, 0, 0)");
    grad.addColorStop(1, "rgba(0, 0, 0, 0.431)");
    rx.fillStyle = grad;
    rx.fillRect(0, 0, W, H);

    const a = got.getContext("2d").getImageData(0, 0, W, H).data;
    const b = rx.getImageData(0, 0, W, H).data;
    let sum = 0;
    let max = 0;
    for (let i = 0; i < a.length; i += 4)
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a[i + c]! - b[i + c]!);
        sum += d;
        max = Math.max(max, d);
      }
    const mean = sum / ((a.length / 4) * 3);
    assert.ok(max <= 8, `${W}x${H}: max diff ${max}/255`);
    assert.ok(mean < 1, `${W}x${H}: mean diff ${mean.toFixed(2)}/255`);
  }
});
