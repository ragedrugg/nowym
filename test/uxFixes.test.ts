import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "gramio";
import { helpText, registerPrivateFallback, startText } from "../src/bot/handlers/common.ts";
import { nowPlayingMarkup } from "../src/bot/markup.ts";

const urlsOf = (kb: ReturnType<typeof nowPlayingMarkup>): string[] =>
  kb
    .build()
    .inline_keyboard.flat()
    .map((b) => ("url" in b ? String(b.url) : ""));

test("nowPlayingMarkup: «слушать в лс» только для числовых id", () => {
  assert.equal(urlsOf(nowPlayingMarkup("123", "nowymbot")).filter((u) => u.includes("start=track_")).length, 1);
  assert.equal(urlsOf(nowPlayingMarkup("a1b2-uuid", "nowymbot")).filter((u) => u.includes("start=track_")).length, 0);
  assert.equal(urlsOf(nowPlayingMarkup("123", null)).filter((u) => u.includes("start=track_")).length, 0);
});

test("registerPrivateFallback: подсказка в личке на текст; команды, группы и via_bot — мимо", async () => {
  let handler: ((ctx: unknown, next: () => Promise<void>) => Promise<void>) | undefined;
  registerPrivateFallback({
    on: (_: string, h: typeof handler) => {
      handler = h;
    },
  } as unknown as Bot);
  assert.ok(handler);

  const run = async (ctx: Record<string, unknown>): Promise<{ replies: string[]; nexted: boolean }> => {
    const replies: string[] = [];
    let nexted = false;
    await handler!({ reply: async (t: string) => void replies.push(t), ...ctx }, async () => {
      nexted = true;
    });
    return { replies, nexted };
  };

  const hit = await run({ chat: { type: "private" }, text: "привет" });
  assert.equal(hit.replies.length, 1);
  assert.match(hit.replies[0]!, /так не ищу/);
  assert.equal(hit.nexted, false);

  for (const ctx of [
    { chat: { type: "private" }, text: "/foo" },
    { chat: { type: "private" }, text: undefined },
    { chat: { type: "private" }, text: "x", viaBot: {} },
    { chat: { type: "supergroup" }, text: "привет" },
  ]) {
    const r = await run(ctx);
    assert.deepEqual(r.replies, []);
    assert.equal(r.nexted, true);
  }
});

test("тексты: старт и help без устаревших формулировок", () => {
  assert.match(startText(true).toString(), /набери @nowymbot название в любом чате/);
  assert.match(startText(false).toString(), /войди, это минута/);
  const help = helpText().toString();
  assert.match(help, /плейлист/);
  assert.match(help, /ncore/);
  assert.match(help, /\/np/);
});
