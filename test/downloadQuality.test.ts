/** Выбор варианта загрузки по качеству — selectDownloadInfo (#6). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { selectDownloadInfo } from "../src/yandex/metadata.ts";

const mk = (codec: string, bitrateInKbps: number) => ({ codec, bitrateInKbps });

test("selectDownloadInfo: best — макс. битрейт", () => {
  const infos = [mk("mp3", 192), mk("mp3", 320), mk("aac", 128)];
  assert.deepEqual(selectDownloadInfo(infos, "best"), mk("mp3", 320));
});

test("selectDownloadInfo: best — при равном битрейте предпочтение mp3", () => {
  const infos = [mk("aac", 320), mk("mp3", 320)];
  assert.deepEqual(selectDownloadInfo(infos, "best"), mk("mp3", 320));
});

test("selectDownloadInfo: economy — лучший ≤192", () => {
  const infos = [mk("mp3", 320), mk("mp3", 192), mk("aac", 128)];
  assert.deepEqual(selectDownloadInfo(infos, "economy"), mk("mp3", 192));
});

test("selectDownloadInfo: economy — все варианты выше порога → самый низкий", () => {
  const infos = [mk("mp3", 320), mk("aac", 256)];
  assert.deepEqual(selectDownloadInfo(infos, "economy"), mk("aac", 256));
});

test("selectDownloadInfo: фолбэк, если нет mp3/aac", () => {
  const infos = [mk("flac", 1000)];
  assert.deepEqual(selectDownloadInfo(infos, "best"), mk("flac", 1000));
  assert.deepEqual(selectDownloadInfo(infos, "economy"), mk("flac", 1000));
});

test("selectDownloadInfo: пусто/null → null", () => {
  assert.equal(selectDownloadInfo([], "best"), null);
  assert.equal(selectDownloadInfo(null, "economy"), null);
  assert.equal(selectDownloadInfo(undefined), null);
});

test("selectDownloadInfo: дефолт quality = best", () => {
  const infos = [mk("mp3", 128), mk("mp3", 320)];
  assert.deepEqual(selectDownloadInfo(infos), mk("mp3", 320));
});
