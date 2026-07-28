/** splitLyricsLine — разбивка строки лирики на жирную/курсивную части.
 * Чинили на сохранение пунктуации и неразрыв дефиса внутри слова. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildTrackCaption, splitLyricsLine } from "../src/bot/captions.ts";

test("splitLyricsLine: режет по запятой, дефис внутри слова не трогает", () => {
  // "чуть-чуть" не должно разорваться по дефису; делит по запятой
  assert.deepEqual(splitLyricsLine("чуть-чуть нежности, моя"), ["чуть-чуть нежности,", "моя"]);
});

test("splitLyricsLine: делит по тире с пробелами", () => {
  assert.deepEqual(splitLyricsLine("раз — два"), ["раз —", "два"]);
});

test("splitLyricsLine: без разделителя — пополам по словам", () => {
  assert.deepEqual(splitLyricsLine("люблю тебя очень сильно"), ["люблю тебя", "очень сильно"]);
});

test("splitLyricsLine: одно слово → вторая часть пустая", () => {
  assert.deepEqual(splitLyricsLine("привет"), ["привет", ""]);
});

test("splitLyricsLine: двоеточие — разделитель", () => {
  assert.deepEqual(splitLyricsLine("слушай: это важно"), ["слушай:", "это важно"]);
});

test("buildTrackCaption: degraded дописывает пометку про недоступное превосходное качество", () => {
  const plain = buildTrackCaption(123, "mp3", 320).text;
  const deg = buildTrackCaption(123, "mp3", 320, true).text;
  assert.ok(!plain.includes("превосходное недоступно"), "обычная подпись без пометки");
  assert.ok(deg.includes("превосходное недоступно"), "degraded подпись с пометкой");
  assert.ok(deg.includes("оптимальное 320"), "качество/битрейт сохранён");
});

test("buildTrackCaption: дружелюбные названия качества вместо кодеков", () => {
  assert.ok(buildTrackCaption(1, "mp3", 320).text.includes("оптимальное"));
  assert.ok(buildTrackCaption(1, "flac", 1411).text.includes("превосходное"));
  assert.ok(buildTrackCaption(1, "flac-mp4", 1000).text.includes("превосходное"));
  assert.ok(buildTrackCaption(1, "aac", 256).text.includes("экономичное"));
  assert.ok(buildTrackCaption(1, "he-aac-mp4", 128).text.includes("экономичное"));
});
