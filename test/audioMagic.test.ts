/** hasAudioMagic / assertAudioMagic: контейнер скачанных байт по магии (P4A). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AudioMagicError, assertAudioMagic, hasAudioMagic } from "../src/yandex/audioMagic.ts";

const mp4 = Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

test("mp4-семейство: ftyp по смещению 4", () => {
  for (const c of ["flac-mp4", "aac-mp4", "he-aac-mp4"]) assert.equal(hasAudioMagic(mp4, c), true, c);
  assert.equal(hasAudioMagic(Buffer.from("<html>not audio</html>"), "flac-mp4"), false);
  assert.equal(hasAudioMagic(Buffer.from("ftyp"), "flac-mp4"), false, "ftyp со смещением 0 — не контейнер");
  assert.equal(hasAudioMagic(Buffer.alloc(3), "aac-mp4"), false, "короче 8 байт");
});

test("flac: fLaC; encraw-мусор отвергается", () => {
  assert.equal(hasAudioMagic(Buffer.from("fLaC\0\0\0\x22"), "flac"), true);
  assert.equal(hasAudioMagic(Buffer.from("OggS"), "flac"), false);
  assert.equal(hasAudioMagic(mp4, "flac"), false);
});

test("mp3: ID3 или синхрослово 0xFFEx", () => {
  assert.equal(hasAudioMagic(Buffer.from("ID3\x04\0"), "mp3"), true);
  assert.equal(hasAudioMagic(Buffer.from([0xff, 0xfb, 0x90, 0]), "mp3"), true);
  assert.equal(hasAudioMagic(Buffer.from([0xff, 0x1b, 0, 0]), "mp3"), false);
  assert.equal(hasAudioMagic(Buffer.from('{"error":1}'), "mp3"), false);
});

test("неизвестный/пустой кодек не проверяется", () => {
  assert.equal(hasAudioMagic(Buffer.from("zzzz"), "aac"), true);
  assert.equal(hasAudioMagic(Buffer.from("zzzz"), null), true);
});

test("assertAudioMagic бросает AudioMagicError", () => {
  assert.throws(() => assertAudioMagic(Buffer.from("garbage!"), "flac-mp4"), AudioMagicError);
  assert.doesNotThrow(() => assertAudioMagic(mp4, "flac-mp4"));
});

/** ID3v2-заголовок: "ID3", ver(2), flags(1), synchsafe size(4) + тело нужного размера. */
const id3v2 = (bodySize: number, footer = false): Buffer =>
  Buffer.concat([
    Buffer.from([
      0x49,
      0x44,
      0x33,
      0x04,
      0,
      footer ? 0x10 : 0,
      (bodySize >> 21) & 0x7f,
      (bodySize >> 14) & 0x7f,
      (bodySize >> 7) & 0x7f,
      bodySize & 0x7f,
    ]),
    Buffer.alloc(bodySize),
    footer ? Buffer.alloc(10) : Buffer.alloc(0),
  ]);

test("flac: ID3v2-префикс пропускается по synchsafe-размеру, дальше fLaC", () => {
  const flac = Buffer.from([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0x22]);
  assert.equal(hasAudioMagic(Buffer.concat([id3v2(300), flac]), "flac"), true);
  assert.equal(hasAudioMagic(Buffer.concat([id3v2(0), flac]), "flac"), true);
  assert.equal(hasAudioMagic(Buffer.concat([id3v2(5, true), flac]), "flac"), true, "footer +10");
  assert.equal(hasAudioMagic(Buffer.concat([id3v2(300), Buffer.from("OggS....")]), "flac"), false);
  assert.equal(hasAudioMagic(Buffer.concat([id3v2(300), mp4]), "flac"), false);
});

test("flac: ID3 без данных после тега / обрезанный заголовок / несинхробезопасный размер => false", () => {
  assert.equal(hasAudioMagic(id3v2(10), "flac"), false, "тег есть, fLaC нет");
  assert.equal(
    hasAudioMagic(Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0]), "flac"),
    false,
    "заголовок короче 10 байт",
  );
  assert.equal(
    hasAudioMagic(Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0x80, 0, 0, 0, 0x66, 0x4c, 0x61, 0x43]), "flac"),
    false,
  );
});

test("mp4-семейство: фрагментированный mp4 со styp по смещению 4", () => {
  const styp = Buffer.from([0, 0, 0, 0x18, 0x73, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  for (const c of ["flac-mp4", "aac-mp4", "he-aac-mp4", "mp4"]) assert.equal(hasAudioMagic(styp, c), true, c);
  assert.equal(hasAudioMagic(Buffer.from([0, 0, 0, 0x18, 0x73, 0x74, 0x79, 0x71]), "aac-mp4"), false, "styq");
  assert.equal(hasAudioMagic(styp, "flac"), false, "styp не flac");
});

test("короткие буферы: отвергаются, ничего не бросается", () => {
  for (const c of ["flac", "mp3", "aac-mp4", "flac-mp4"]) {
    assert.equal(hasAudioMagic(Buffer.alloc(0), c), false, c);
    assert.equal(hasAudioMagic(Buffer.from([0x66]), c), false, c);
  }
  assert.equal(
    hasAudioMagic(Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0]), "flac"),
    false,
    "заголовок короче 10 байт",
  );
});

test("шифртекст/HTML/JSON отвергаются для всех проверяемых кодеков", () => {
  const junk = [
    Buffer.from("<!DOCTYPE html>"),
    Buffer.from('{"error":"x"}'),
    Buffer.from([0x9a, 0x3c, 0x11, 0xe0, 0x55, 0x01, 0x7f, 0x80, 0x00, 0x42]),
  ];
  for (const c of ["flac", "mp3", "aac-mp4", "flac-mp4", "he-aac-mp4", "mp4"])
    for (const j of junk) assert.equal(hasAudioMagic(j, c), false, `${c}: ${j.subarray(0, 4).toString("hex")}`);
});

test("mp3 с ведущими нулями (padding) остаётся отвергнутым: не ослабляем проверку", () => {
  assert.equal(hasAudioMagic(Buffer.concat([Buffer.alloc(4), Buffer.from([0xff, 0xfb, 0x90, 0])]), "mp3"), false);
});
