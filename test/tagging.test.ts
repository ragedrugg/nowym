/** Tagging — пустышки байт-в-байт с Python + round-trip тегов через ffmpeg/ffprobe. */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEmptyMp3, getFilename } from "../src/tagging/emptyMp3.ts";
import { TaggingService } from "../src/tagging/service.ts";
import { origCoverUrl } from "../src/yandex/media.ts";
import type { TrackMetadata } from "../src/yandex/types.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** валидное ~0.3с тишины. extra — доп. флаги ffmpeg (напр. FLAC-в-MP4). */
async function genSilence(ext: string, extra: string[] = []): Promise<Buffer> {
  const path = join(tmpdir(), `nowym-gen-${randomUUID()}.${ext}`);
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=stereo",
      "-t",
      "0.3",
      ...extra,
      path,
    ]);
    proc.on("error", reject);
    proc.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`gen ${ext} ${c}`))));
  });
  try {
    return await readFile(path);
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

/** ffprobe -show_format -show_streams → JSON. */
async function ffprobe(buf: Buffer, ext: string): Promise<any> {
  const path = join(tmpdir(), `nowym-probe-${randomUUID()}.${ext}`);
  await writeFile(path, buf);
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const proc = spawn("ffprobe", ["-loglevel", "error", "-show_format", "-show_streams", "-of", "json", path]);
      let stdout = "";
      proc.stdout.on("data", (d) => (stdout += d));
      proc.on("error", reject);
      proc.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`ffprobe ${code}`))));
    });
    return JSON.parse(out);
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

test("createEmptyMp3 — байт-в-байт с Python create_empty_mp3", () => {
  const withAlbum = createEmptyMp3("Artist", "Title", "Album");
  assert.equal(withAlbum.length, 15927);
  assert.equal(sha(withAlbum), "dbcbe52c24752d8b21f253a858c2a5c327039a461849d4107a761cb3161bf407");

  const noAlbum = createEmptyMp3("A", "B", null);
  assert.equal(noAlbum.length, 15886);
  assert.equal(sha(noAlbum), "0f025a6e076722a4500269015fa5ced3be485c0ed020eed27ef87fedb1134d3c");
});

test("getFilename — чистит запрещённые символы", () => {
  assert.equal(getFilename("a/b<c>", "d:e*f"), "a_b_c_ - d_e_f.mp3");
  assert.equal(getFilename("", "", "aac"), "Unknown - Unknown.m4a");
});

test("origCoverUrl — подменяет размер на orig", () => {
  assert.equal(origCoverUrl("https://x.net/a/400x400"), "https://x.net/a/orig");
  assert.equal(origCoverUrl("https://x.net/a/200x200?q=1"), "https://x.net/a/orig?q=1");
  assert.equal(origCoverUrl(""), "");
});

const META: TrackMetadata = {
  artist: "Артист",
  album_artist: "Артист",
  title: "Песня",
  album: "Альбом",
  year: "2021",
  label: "Лейбл",
  genre: "pop",
  composer: "Композитор",
  version: "Remastered",
  explicit: true,
  duration: 200,
  track_number: 3,
  track_total: 12,
  disc_number: 1,
  disc_total: 1,
  cover_url: "",
  cover_data: null,
};

// минимальный валидный jpeg 1x1 (для проверки вшивания обложки)
const JPEG_1x1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwA//9k=",
  "base64",
);

// codec → (ext генерации фикстуры, ext выходного контейнера)
const FORMATS: Array<[string, string, string]> = [
  ["mp3", "mp3", "mp3"],
  ["aac", "m4a", "m4a"],
  ["flac", "flac", "flac"],
  ["flac-mp4", "m4a", "m4a"],
];

// flac-в-mp4 (.m4a) — особый случай: генерим через mp4-muxer (ipod не пишет FLAC)
const GEN_EXTRA: Record<string, string[]> = {
  "flac-mp4": ["-c:a", "flac", "-strict", "experimental", "-f", "mp4"],
};

for (const [codec, genExt, outExt] of FORMATS) {
  test(`TaggingService.addMetadata (${codec}) — теги читаются ffprobe + обложка вшита`, async () => {
    const src = await genSilence(genExt, GEN_EXTRA[codec] ?? []);
    const tagged = await new TaggingService().addMetadata(src, { ...META, cover_data: JPEG_1x1 }, codec);
    assert.notEqual(sha(tagged), sha(src)); // теги реально записались

    const info = await ffprobe(tagged, outExt);
    // ключи тегов в разных контейнерах в разном регистре — нормализуем
    const t: Record<string, string> = {};
    for (const [k, v] of Object.entries(info.format.tags ?? {})) t[k.toLowerCase()] = String(v);

    assert.equal(t.title, "Песня");
    assert.equal(t.artist, "Артист");
    assert.equal(t.album, "Альбом");
    assert.equal(t.album_artist, "Артист");
    assert.equal(t.genre, "pop");
    assert.equal(t.composer, "Композитор");
    assert.match(t.track ?? "", /^3(\/12)?$/);
    assert.match(String(t.date ?? ""), /2021/);
    // обложка — отдельный поток с attached_pic
    const pic = info.streams.find((s: any) => s.disposition?.attached_pic === 1);
    assert.ok(pic, `обложка должна быть вшита как attached_pic (${codec})`);
  });
}

test("TaggingService.addMetadata — битый ввод отдаёт исходник", async () => {
  const junk = Buffer.from("это не аудио, ffmpeg не распарсит");
  const out = await new TaggingService().addMetadata(junk, { artist: "A", title: "B" } as TrackMetadata, "mp3");
  assert.equal(out, junk);
});

test("TaggingService.addMetadata — transform (эффект) идёт через ffmpeg, не TagLib", async () => {
  const src = await genSilence("mp3");
  const tagged = await new TaggingService().addMetadata(src, { ...META, cover_data: JPEG_1x1 }, "mp3", {
    filter: "atempo=1.2",
  });
  assert.notEqual(sha(tagged), sha(src));

  const info = await ffprobe(tagged, "mp3");
  const t: Record<string, string> = {};
  for (const [k, v] of Object.entries(info.format.tags ?? {})) t[k.toLowerCase()] = String(v);
  assert.equal(t.title, "Песня");
  assert.equal(t.artist, "Артист");
  assert.equal(info.streams[0]?.codec_name, "mp3"); // transform всегда отдаёт mp3
  const pic = info.streams.find((s: any) => s.disposition?.attached_pic === 1);
  assert.ok(pic, "обложка должна быть вшита и в transform-пути");
});
