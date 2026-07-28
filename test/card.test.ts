/** Карточка: чистые хелперы + smoke-рендер (валидный JPEG). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cleanTrackTitle, composeTitleWithVersion, fmtMmss, renderNowPlayingCard } from "../src/services/card.ts";

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
