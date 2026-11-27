import assert from "node:assert/strict";
import { test } from "node:test";
import { registerPrivateFallback } from "../src/bot/handlers/common.ts";
import { nowPlayingMarkup } from "../src/bot/markup.ts";
import { helpText, startText } from "../src/bot/texts.ts";
import type { AppBot as Bot } from "../src/bot/types.ts";

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
    { chat: { type: "private" }, text: "x", via_bot: {} },
    { chat: { type: "supergroup" }, text: "привет" },
  ]) {
    const r = await run(ctx);
    assert.deepEqual(r.replies, []);
    assert.equal(r.nexted, true);
  }
});

test("тексты: старт и help без устаревших формулировок", () => {
  assert.match(startText(true).text, /набери @nowymbot название в любом чате/);
  assert.match(startText(false).text, /войди, это минута/);
  const help = helpText().text;
  assert.match(help, /плейлист/);
  assert.match(help, /ncore/);
  assert.match(help, /\/np/);
});

test("D7: тексты подставляют username бота из getMe, а не захардкоженный @nowymbot", async () => {
  assert.match(startText(true, "otherbot").text, /набери @otherbot название/);
  assert.ok(!startText(true, "otherbot").text.includes("nowymbot"));
  assert.match(helpText("otherbot").text, /@otherbot/);
  assert.ok(!helpText("otherbot").text.includes("nowymbot"));

  let handler: ((ctx: unknown, next: () => Promise<void>) => Promise<void>) | undefined;
  registerPrivateFallback(
    {
      on: (_: string, h: typeof handler) => {
        handler = h;
      },
    } as unknown as Bot,
    { botUsername: "otherbot" },
  );
  const replies: string[] = [];
  await handler!(
    { chat: { type: "private" }, text: "привет", reply: async (t: string) => void replies.push(t) },
    async () => {},
  );
  assert.match(replies[0]!, /набери @otherbot название/);
});

test("D7: TaggingService пишет encoded_by из username бота", async () => {
  const { TaggingService } = await import("../src/tagging/service.ts");
  const pairs = (svc: InstanceType<typeof TaggingService>) => [
    ...(svc as unknown as { metaPairs(m: unknown): Iterable<[string, string]> }).metaPairs({ artist: "A", title: "B" }),
  ];
  assert.deepEqual(
    pairs(new TaggingService("otherbot")).find(([k]) => k === "encoded_by"),
    ["encoded_by", "@otherbot"],
  );
  assert.deepEqual(
    pairs(new TaggingService()).find(([k]) => k === "encoded_by"),
    ["encoded_by", "@nowymbot"],
    "без username — прежний дефолт",
  );
});
