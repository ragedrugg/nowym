import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCardResultId,
  hashPhrase,
  cardCaption,
  cardMediaAndMarkup,
  trackCardBasics,
  buildNowPlayingCardResult,
  buildLyricsCardResult,
} from "../src/bot/handlers/inlineCard.ts";
import type { Container } from "../src/bot/container.ts";
import type { YaTrack } from "../src/yandex/types.ts";

function mkTrack(id: number | string = 1): YaTrack {
  return { id, title: "Song", artists: [{ name: "Artist" }], coverUri: "avatars.yandex.net/get/%%" };
}

function mkContainer(botUsername: string | null = "nowymbot"): Container {
  return { botUsername } as unknown as Container;
}

test("isCardResultId — только npc:/lyc: префиксы", () => {
  assert.equal(isCardResultId("npc:1:2:3"), true);
  assert.equal(isCardResultId("lyc:1:2:3"), true);
  assert.equal(isCardResultId("tm:123"), false);
  assert.equal(isCardResultId("album:1"), false);
  assert.equal(isCardResultId(""), false);
});

test("hashPhrase — детерминирован, разные фразы обычно расходятся", () => {
  assert.equal(hashPhrase("привет"), hashPhrase("привет"));
  assert.notEqual(hashPhrase("привет"), hashPhrase("пока"));
  assert.equal(typeof hashPhrase(""), "number");
});

test("cardCaption — без артиста не дублирует «—»", () => {
  const withArtist = cardCaption(1, "Artist", "Title");
  const noArtist = cardCaption(1, "", "Title");
  assert.notEqual(String(withArtist), String(noArtist));
});

test("cardMediaAndMarkup — layout 'none': без caption и markup", () => {
  const { media, markup } = cardMediaAndMarkup({
    fileId: "f1", trackId: 1, artist: "A", title: "T", cardLayout: "none", botUsername: "bot",
  });
  assert.equal(media.type, "photo");
  assert.equal("caption" in media, false);
  assert.equal(markup, undefined);
});

test("cardMediaAndMarkup — layout 'text': caption есть, markup нет", () => {
  const { media, markup } = cardMediaAndMarkup({
    fileId: "f1", trackId: 1, artist: "A", title: "T", cardLayout: "text", botUsername: "bot",
  });
  assert.ok(media.caption);
  assert.equal(markup, undefined);
});

test("cardMediaAndMarkup — layout 'both': caption и markup есть", () => {
  const { media, markup } = cardMediaAndMarkup({
    fileId: "f1", trackId: 1, artist: "A", title: "T", cardLayout: "both", botUsername: "bot",
  });
  assert.ok(media.caption);
  assert.ok(markup);
});

test("cardMediaAndMarkup — layout 'button' (дефолт): markup есть, caption нет", () => {
  const { media, markup } = cardMediaAndMarkup({
    fileId: "f1", trackId: 1, artist: "A", title: "T", cardLayout: "button", botUsername: "bot",
  });
  assert.equal("caption" in media, false);
  assert.ok(markup);
});

test("trackCardBasics — собирает artist/title/обложки/handle", () => {
  const b = trackCardBasics(mkTrack(), { username: "vasya" });
  assert.equal(b.artist, "Artist");
  assert.equal(b.title, "Song");
  assert.equal(b.senderHandle, "@vasya");
  assert.ok(b.coverUrl.includes("1000x1000"));
  assert.ok(b.thumb.includes("100x100"));
});

test("buildNowPlayingCardResult — resultId содержит userId (изоляция между пользователями)", () => {
  const container = mkContainer();
  const track = mkTrack(777);
  const r1 = buildNowPlayingCardResult(container, track, { progress_ms: 5000 }, { id: 1 });
  const r2 = buildNowPlayingCardResult(container, track, { progress_ms: 5000 }, { id: 2 });
  assert.ok(r1 && r2);
  // тот же трек+секунда, разные юзеры — result_id обязан разойтись, иначе
  // рендер одного могло бы утащить payload другого (ровно тот класс бага,
  // что чинили в inline.ts trackCache).
  assert.notEqual((r1 as { id: string }).id, (r2 as { id: string }).id);
  assert.match((r1 as { id: string }).id, /^npc:1:777:/);
  assert.match((r2 as { id: string }).id, /^npc:2:777:/);
});

test("buildLyricsCardResult — resultId тоже содержит userId, разные фразы расходятся", () => {
  const container = mkContainer();
  const track = mkTrack(777);
  const r1 = buildLyricsCardResult(container, track, "phrase one", { id: 1 });
  const r2 = buildLyricsCardResult(container, track, "phrase one", { id: 2 });
  const r3 = buildLyricsCardResult(container, track, "phrase two", { id: 1 });
  assert.ok(r1 && r2 && r3);
  const id1 = (r1 as { id: string }).id;
  const id2 = (r2 as { id: string }).id;
  const id3 = (r3 as { id: string }).id;
  assert.notEqual(id1, id2, "разные юзеры — разные id");
  assert.notEqual(id1, id3, "разные фразы — разные id");
  assert.match(id1, /^lyc:1:777:/);
});
