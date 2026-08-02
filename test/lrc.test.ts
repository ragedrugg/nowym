import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterLrcLines, isLrc, parseLrc } from "../src/yandex/lrc.ts";

describe("parseLrc", () => {
  it("стандартный формат [MM:SS.cc]", () => {
    const text = "[00:01.50]Первая строка\n[00:04.80]Вторая строка\n[00:08.10]Третья строка";
    const lines = parseLrc(text);
    assert.equal(lines.length, 3);
    assert.equal(lines[0]!.timeMs, 1500);
    assert.equal(lines[0]!.text, "Первая строка");
    assert.equal(lines[1]!.timeMs, 4800);
    assert.equal(lines[2]!.timeMs, 8100);
  });

  it("миллисекунды [MM:SS.xxx]", () => {
    const text = "[01:23.456]Hello\n[02:10.001]World";
    const lines = parseLrc(text);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.timeMs, 83456);
    assert.equal(lines[1]!.timeMs, 130001);
  });

  it("comma-разделитель [MM:SS,ccc]", () => {
    const text = "[00:05,123]Line one\n[00:10,000]Line two";
    const lines = parseLrc(text);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.timeMs, 5123);
    assert.equal(lines[1]!.timeMs, 10000);
  });

  it("служебные теги игнорируются", () => {
    const text = "[ti:My Song]\n[ar:Artist]\n[al:Album]\n[00:01.00]Первая строка";
    const lines = parseLrc(text);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.text, "Первая строка");
  });

  it("пустые строки без таймкода игнорируются", () => {
    const text = "\n[00:01.00]Строка\n\n[00:03.00]Ещё";
    const lines = parseLrc(text);
    assert.equal(lines.length, 2);
  });

  it("строки сортируются по времени", () => {
    const text = "[00:05.00]Позже\n[00:01.00]Раньше\n[00:03.00]Средняя";
    const lines = parseLrc(text);
    assert.equal(lines[0]!.timeMs, 1000);
    assert.equal(lines[1]!.timeMs, 3000);
    assert.equal(lines[2]!.timeMs, 5000);
  });

  it("однозначная дробь [MM:SS.d] → ×100ms", () => {
    const text = "[00:01.5]Test\n[00:03.0]End";
    const lines = parseLrc(text);
    assert.equal(lines[0]!.timeMs, 1500);
    assert.equal(lines[1]!.timeMs, 3000);
  });

  it("пустой текст → пустой массив", () => {
    assert.deepEqual(parseLrc(""), []);
    assert.deepEqual(parseLrc("   "), []);
  });

  it("строки с пробелами вокруг текста тримируются", () => {
    const text = "[00:01.00]  с пробелами  ";
    const lines = parseLrc(text);
    assert.equal(lines[0]!.text, "с пробелами");
  });
});

describe("filterLrcLines", () => {
  it("убирает пустые строки-паузы", () => {
    const lines = [
      { timeMs: 1000, text: "" },
      { timeMs: 2000, text: "♪" },
      { timeMs: 3000, text: "•" },
      { timeMs: 4000, text: "—" },
      { timeMs: 5000, text: "Настоящий текст" },
    ];
    const filtered = filterLrcLines(lines);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]!.text, "Настоящий текст");
  });

  it("оставляет строки с текстом", () => {
    const lines = [
      { timeMs: 1000, text: "Первая" },
      { timeMs: 2000, text: "Вторая" },
    ];
    assert.equal(filterLrcLines(lines).length, 2);
  });

  it("пустой массив → пустой массив", () => {
    assert.deepEqual(filterLrcLines([]), []);
  });
});

describe("isLrc", () => {
  it("true при наличии таймкода", () => {
    assert.equal(isLrc("[00:01.50]Hello"), true);
    assert.equal(isLrc("[01:23.456]World"), true);
    assert.equal(isLrc("[00:05,123]Test"), true);
  });

  it("false для обычного текста", () => {
    assert.equal(isLrc("Просто текст без таймкодов"), false);
    assert.equal(isLrc(""), false);
    assert.equal(isLrc("[ti:My Song]"), false);
    assert.equal(isLrc("[ar:Artist Name]"), false);
  });

  it("false для неполных паттернов", () => {
    assert.equal(isLrc("[01:23]без дробной части"), false);
  });
});
