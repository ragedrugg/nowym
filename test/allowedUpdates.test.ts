/** allowed_updates: только обрабатываемые типы, и каждый тип с хендлером в списке есть. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DialogState } from "@yaebal/morda";
import { MemoryStorage } from "yaebal";
import { ALLOWED_UPDATES, buildBot } from "../src/bot/app.ts";
import type { Container } from "../src/bot/container.ts";

test("ALLOWED_UPDATES покрывает все типы апдейтов, на которые у бота есть хендлеры", () => {
  const bot = buildBot({
    token: "1:test",
    container: { knownChatsDb: null } as unknown as Container,
    dialogStorage: new MemoryStorage<DialogState>(),
    fetch: (async () => new Response("{}")) as typeof fetch,
  });
  const registered = [...bot.registeredUpdates()];
  assert.ok(registered.length > 0);
  for (const t of registered) assert.ok(ALLOWED_UPDATES.includes(t), `${t} не в ALLOWED_UPDATES`);
});

test("ALLOWED_UPDATES не тянет полный список Bot API", () => {
  assert.deepEqual([...ALLOWED_UPDATES].sort(), ["callback_query", "chosen_inline_result", "inline_query", "message"]);
});
