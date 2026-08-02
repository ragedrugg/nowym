/** Чистые функции yandex/metadata.ts — порт логики из Python. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalizeCoverUrl } from "../src/yandex/media.ts";
import {
  albumEmoji,
  albumTypeRu,
  buildCardMeta,
  findBestLyricsLine,
  formatArtists,
  formatDurationHuman,
  isSingle,
  LABELED_ALBUM_TYPES,
  metaNeedsWaveColor,
  selectDownloadInfo,
  waveColorFromLottie,
} from "../src/yandex/metadata.ts";
import type { CardMeta, YaTrack } from "../src/yandex/types.ts";

test("formatArtists", () => {
  assert.equal(formatArtists([{ name: "A" }, { name: "B" }]), "A, B");
  assert.equal(formatArtists([]), "Unknown");
  assert.equal(formatArtists(null, "—"), "—");
  assert.equal(formatArtists([{ id: 1 }]), "Unknown"); // нет name
});

test("formatDurationHuman", () => {
  assert.equal(formatDurationHuman(185_000), "3:05");
  assert.equal(formatDurationHuman(3_725_000), "1:02:05");
  assert.equal(formatDurationHuman(0), "0:00");
  assert.equal(formatDurationHuman(null), "0:00");
});

test("albumTypeRu — словарь + fallback по track_count", () => {
  assert.equal(albumTypeRu("single"), "сингл");
  assert.equal(albumTypeRu("EP"), "EP");
  assert.equal(albumTypeRu(null, 1), "сингл");
  assert.equal(albumTypeRu(null, 4), "EP");
  assert.equal(albumTypeRu(null, 10), "альбом");
  assert.equal(albumTypeRu(null, null), null);
});

test("albumEmoji — подкаст/аудиокнига получают свой значок, остальное — 📀", () => {
  assert.equal(albumEmoji("podcast"), "🎙️");
  assert.equal(albumEmoji("AUDIOBOOK"), "🎧");
  assert.equal(albumEmoji("single"), "📀");
  assert.equal(albumEmoji(null), "📀");
  assert.equal(albumEmoji(undefined), "📀");
});

test("LABELED_ALBUM_TYPES — только podcast/audiobook подписываются явным ru-ярлыком", () => {
  assert.equal(LABELED_ALBUM_TYPES.has("podcast"), true);
  assert.equal(LABELED_ALBUM_TYPES.has("audiobook"), true);
  assert.equal(LABELED_ALBUM_TYPES.has("album"), false);
  assert.equal(LABELED_ALBUM_TYPES.has("single"), false);
});

test("isSingle", () => {
  assert.equal(isSingle("single"), true);
  assert.equal(isSingle(null, 1), true);
  assert.equal(isSingle("album", 10), false);
});

test("selectDownloadInfo — mp3 при равном битрейте", () => {
  const infos = [
    { codec: "aac", bitrateInKbps: 192 },
    { codec: "mp3", bitrateInKbps: 192 },
    { codec: "mp3", bitrateInKbps: 128 },
  ];
  assert.deepEqual(selectDownloadInfo(infos, "best"), { codec: "mp3", bitrateInKbps: 192 });
  assert.equal(selectDownloadInfo([], "best"), null);
});

test("normalizeCoverUrl", () => {
  assert.equal(normalizeCoverUrl("avatars.yandex.net/get/%%", "400x400"), "https://avatars.yandex.net/get/400x400");
  assert.equal(normalizeCoverUrl("//host/x%%", "orig"), "https://host/xorig");
  assert.equal(normalizeCoverUrl(null), "");
});

test("buildCardMeta — извлекает поля без сети", () => {
  const track: YaTrack = {
    id: 42,
    title: "Song",
    contentWarning: "explicit",
    artists: [{ name: "Artist" }],
    albums: [{ id: 7, title: "Alb", year: 2020, type: "single", trackCount: 1, genre: "pop" }],
    derivedColors: { accent: "#aabbcc", average: "#112233", waveText: "#fff" },
  };
  const m = buildCardMeta(track);
  assert.equal(m.album, "Alb");
  assert.equal(m.year, "2020");
  assert.equal(m.type_ru, "сингл");
  assert.equal(m.explicit, true);
  assert.equal(m.is_single, true);
  assert.equal(m.album_id, 7);
  assert.equal(m.track_id, 42);
  assert.equal(m.colors.accent, "#aabbcc");
  assert.equal(m.liked, null);
});

test("metaNeedsWaveColor — серый accent требует wave-цвет", () => {
  const gray: CardMeta = { ...baseMeta(), colors: { accent: "#808080" }, album_id: 1 };
  const vivid: CardMeta = { ...baseMeta(), colors: { accent: "#ff0033" }, album_id: 1 };
  assert.equal(metaNeedsWaveColor(gray), true);
  assert.equal(metaNeedsWaveColor(vivid), false);
  assert.equal(metaNeedsWaveColor({ ...gray, colors: { wave: "#abc" } }), false); // уже есть
  assert.equal(metaNeedsWaveColor({ ...gray, album_id: null }), false); // нет альбома
});

test("waveColorFromLottie — fill слоя color", () => {
  const lottie = Buffer.from(
    JSON.stringify({
      layers: [{ nm: "color", shapes: [{ it: [{ ty: "fl", c: { k: [1, 0, 0, 1] } }] }] }],
    }),
  );
  assert.equal(waveColorFromLottie(lottie), "#ff0000");
  assert.equal(waveColorFromLottie(Buffer.from("not json")), null);
});

test("findBestLyricsLine — точное вхождение, потом пересечение слов", () => {
  const lyrics = "first line here\nsecond magic line\nthird";
  assert.equal(findBestLyricsLine("magic", lyrics), "second magic line");
  assert.equal(findBestLyricsLine("first here", lyrics), "first line here");
  assert.equal(findBestLyricsLine("zzz qqq", lyrics), null);
});

function baseMeta(): CardMeta {
  return {
    album: "",
    album_type: "",
    type_ru: "",
    year: "",
    labels: [],
    genre: "",
    track_number: null,
    track_total: null,
    version: "",
    explicit: false,
    is_single: false,
    colors: {},
    album_id: null,
    track_id: null,
    liked: null,
  };
}
