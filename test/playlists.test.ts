import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlaylistAlbumData } from "../src/yandex/client.ts";
import type { YaTrack } from "../src/yandex/types.ts";

function mkTrack(id: number, available = true): YaTrack {
  return { id, title: `трек ${id}`, available };
}

test("buildPlaylistAlbumData — фильтрует недоступные, нумерует оставшиеся по порядку", () => {
  const tracks = [mkTrack(1), mkTrack(2, false), mkTrack(3)];
  const album = buildPlaylistAlbumData(42, "мой плейлист", "avatars.yandex.net/get-music/%%/orig", tracks);

  assert.ok(album);
  assert.equal(album!.tracks.length, 2);
  assert.deepEqual(
    album!.tracks.map((t) => t.id),
    [1, 3],
  );
  assert.equal(album!.tracks[0]!._trackNumber, 1);
  assert.equal(album!.tracks[1]!._trackNumber, 2);
  assert.equal(album!.tracks[0]!._discNumber, 1);
});

test("buildPlaylistAlbumData — все треки недоступны → null", () => {
  const album = buildPlaylistAlbumData(1, "пусто", "", [mkTrack(1, false), mkTrack(2, false)]);
  assert.equal(album, null);
});

test("buildPlaylistAlbumData — пустой список треков → null", () => {
  assert.equal(buildPlaylistAlbumData(1, "пусто", "", []), null);
});

test("buildPlaylistAlbumData — поля AlbumData под переиспользуемую инфру альбомов", () => {
  const album = buildPlaylistAlbumData(42, "мой плейлист", "", [mkTrack(1)]);
  assert.ok(album);
  assert.equal(album!.id, 42);
  assert.equal(album!.title, "мой плейлист");
  assert.equal(album!.artist, "Плейлист");
  assert.equal(album!.album_type, "playlist");
  assert.equal(album!.volumes.length, 1, "один общий 'диск' — у плейлиста нет дисков");
  assert.deepEqual(album!.volumes[0], album!.tracks);
});

test("buildPlaylistAlbumData — пустой coverUri не роняет normalizeCoverUrl", () => {
  const album = buildPlaylistAlbumData(1, "x", "", [mkTrack(1)]);
  assert.equal(album!.cover_url, "");
});
