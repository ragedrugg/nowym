import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChosenEditPayload, parseTrackResultId } from "../src/bot/handlers/inline.ts";

test("parseTrackResultId", () => {
  assert.equal(parseTrackResultId("123456"), "123456");
  assert.equal(parseTrackResultId("tm:123456"), "123456");
  assert.equal(parseTrackResultId("tm:abc"), null);
  assert.equal(parseTrackResultId("album:1"), null);
  assert.equal(parseTrackResultId(""), null);
});

test("buildChosenEditPayload — layout 'none': без caption и без markup", () => {
  const { media, markup } = buildChosenEditPayload({
    trackId: "1",
    fileId: "f1",
    codec: "mp3",
    bitrateKbps: 320,
    layout: "none",
  });
  assert.equal(media.type, "audio");
  assert.equal(media.media, "f1");
  assert.equal("caption" in media, false);
  assert.equal(markup, undefined);
});

test("buildChosenEditPayload — layout 'none' с цитатой лирики добавляет caption", () => {
  const { media } = buildChosenEditPayload({
    trackId: "1",
    fileId: "f1",
    codec: "mp3",
    bitrateKbps: 320,
    layout: "none",
    lyricsQuote: "строчка",
  });
  assert.ok("caption" in media);
});

test("buildChosenEditPayload — layout 'text': caption есть, markup (лайк-кнопка) нет", () => {
  const { media, markup } = buildChosenEditPayload({
    trackId: "1",
    fileId: "f1",
    codec: "mp3",
    bitrateKbps: 320,
    layout: "text",
  });
  assert.ok(media.caption);
  assert.equal(markup, undefined);
});

test("buildChosenEditPayload — layout 'both': caption и лайк-маркап есть", () => {
  const { media, markup } = buildChosenEditPayload({
    trackId: "1",
    fileId: "f1",
    codec: "mp3",
    bitrateKbps: 320,
    layout: "both",
  });
  assert.ok(media.caption);
  assert.ok(markup);
});

test("buildChosenEditPayload — layout 'button' (дефолт): markup есть, caption только с цитатой", () => {
  const noQuote = buildChosenEditPayload({
    trackId: "1",
    fileId: "f1",
    codec: "mp3",
    bitrateKbps: 320,
    layout: "button",
  });
  assert.equal("caption" in noQuote.media, false);
  assert.ok(noQuote.markup);

  const withQuote = buildChosenEditPayload({
    trackId: "1",
    fileId: "f1",
    codec: "mp3",
    bitrateKbps: 320,
    layout: "button",
    lyricsQuote: "строчка",
  });
  assert.ok("caption" in withQuote.media);
  assert.ok(withQuote.markup);
});
