import assert from "node:assert/strict";
import { test } from "node:test";
import { START_PLAYLIST_RE } from "../src/bot/handlers/common.ts";
import { buildPlaylistAlbumData } from "../src/music/client.ts";
import type { Track } from "../src/music/types.ts";

test("deep-link playlist_<id>: 22 base62 разбирается однозначно", () => {
  const id = "37i9dQZF1DXcBWIGoYBM5M";
  assert.deepEqual(START_PLAYLIST_RE.exec(`playlist_${id}`)?.slice(1), [id]);
  assert.equal(START_PLAYLIST_RE.exec("playlist_short"), null);
  assert.equal(START_PLAYLIST_RE.exec("album_" + id), null);
});

function mkTrack(id: string, available = true): Track {
  return { id, title: `трек ${id}`, available };
}

test("buildPlaylistAlbumData — фильтрует недоступные, нумерует оставшиеся по порядку", () => {
  const tracks = [mkTrack("1"), mkTrack("2", false), mkTrack("3")];
  const album = buildPlaylistAlbumData("42", "мой плейлист", "https://i.scdn.co/image/abc", tracks);

  assert.ok(album);
  assert.equal(album!.tracks.length, 2);
  assert.deepEqual(
    album!.tracks.map((t) => t.id),
    ["1", "3"],
  );
  assert.equal(album!.tracks[0]!._trackNumber, 1);
  assert.equal(album!.tracks[1]!._trackNumber, 2);
  assert.equal(album!.tracks[0]!._discNumber, 1);
});

test("buildPlaylistAlbumData — все треки недоступны → null", () => {
  const album = buildPlaylistAlbumData("1", "пусто", "", [mkTrack("1", false), mkTrack("2", false)]);
  assert.equal(album, null);
});

test("buildPlaylistAlbumData — пустой список треков → null", () => {
  assert.equal(buildPlaylistAlbumData("1", "пусто", "", []), null);
});

test("buildPlaylistAlbumData — поля AlbumData под переиспользуемую инфру альбомов", () => {
  const album = buildPlaylistAlbumData("42", "мой плейлист", "", [mkTrack("1")]);
  assert.ok(album);
  assert.equal(album!.id, "42");
  assert.equal(album!.title, "мой плейлист");
  assert.equal(album!.artist, "Плейлист");
  assert.equal(album!.album_type, "playlist");
  assert.equal(album!.volumes.length, 1, "один общий 'диск' — у плейлиста нет дисков");
  assert.deepEqual(album!.volumes[0], album!.tracks);
});

test("buildPlaylistAlbumData — пустой coverUri не роняет normalizeCoverUrl", () => {
  const album = buildPlaylistAlbumData("1", "x", "", [mkTrack("1")]);
  assert.equal(album!.cover_url, "");
});
