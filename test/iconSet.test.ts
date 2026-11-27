/** L6 (review-1): iconFor — алиасы, если в наборе нет точного эмодзи (🔐 → 🔓). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { iconFor, resolveIconSet } from "../src/bot/iconSet.ts";
import type { ApiBot as Bot } from "../src/bot/types.ts";

function botWith(stickers: { emoji: string; custom_emoji_id: string }[]): Bot {
  return { api: { getStickerSet: async () => ({ stickers }) } } as unknown as Bot;
}

test("L6: набор без 🔐 (tgiosicons) — кнопка входа берёт иконку 🔓", async () => {
  await resolveIconSet(
    botWith([
      { emoji: "🔓", custom_emoji_id: "unlock" },
      { emoji: "🔒", custom_emoji_id: "lock" },
    ]),
    "tgiosicons",
  );
  assert.equal(iconFor("🔐"), "unlock");
  assert.equal(iconFor("🔓"), "unlock");
});

test("L6: точное совпадение важнее алиаса (icons_by_nowymbot: есть и 🔐, и 🔓)", async () => {
  await resolveIconSet(
    botWith([
      { emoji: "🔓", custom_emoji_id: "unlock" },
      { emoji: "🔐", custom_emoji_id: "locked-key" },
    ]),
    "icons_by_nowymbot",
  );
  assert.equal(iconFor("🔐"), "locked-key");
});

test("L6: нет ни эмодзи, ни алиасов — undefined (кнопка откатится на глиф)", async () => {
  await resolveIconSet(botWith([{ emoji: "❤️", custom_emoji_id: "heart" }]), "x");
  assert.equal(iconFor("🔐"), undefined);
  assert.equal(iconFor("🎵"), undefined);
});
