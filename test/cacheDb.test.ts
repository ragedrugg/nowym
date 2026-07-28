/** rowToCachedTrack — маппинг строки telegram_cache в CachedTrack (коэрсинг/дефолты). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { rowToCachedTrack } from "../src/storage/cache.ts";

test("rowToCachedTrack: полная строка маппится один-в-один", () => {
  const t = rowToCachedTrack({
    track_id: 12345,
    telegram_file_id: "FILEID",
    telegram_message_id: 678,
    is_cached: true,
    has_metadata: true,
    artist: "Артист",
    title: "Трек",
    album: "Альбом",
    cover_url: "http://cover",
    duration: 210,
    year: "2024",
    label: "Лейбл",
    genre: "pop",
    codec: "flac",
    bitrate_kbps: 1411,
  });
  assert.equal(t.track_id, "12345"); // BIGINT → string
  assert.equal(t.telegram_file_id, "FILEID");
  assert.equal(t.is_cached, true);
  assert.equal(t.bitrate_kbps, 1411);
});

test("rowToCachedTrack: null-поля дефолтятся, track_id коэрсится в string", () => {
  const t = rowToCachedTrack({
    track_id: 42,
    telegram_file_id: null,
    is_cached: 0, // truthy-коэрсинг
    has_metadata: null,
  });
  assert.equal(t.track_id, "42");
  assert.equal(t.telegram_file_id, ""); // null → ""
  assert.equal(t.telegram_message_id, null);
  assert.equal(t.is_cached, false); // Boolean(0)
  assert.equal(t.has_metadata, false);
  assert.equal(t.artist, null);
  assert.equal(t.codec, null);
  assert.equal(t.bitrate_kbps, null);
});
