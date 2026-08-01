import { test } from "node:test";
import assert from "node:assert/strict";

// ADMIN_USER_ID сознательно НЕ задаём — проверяем fail-closed ветку:
// без ADMIN_USER_ID админ-команды не должны работать вообще ни для кого,
// иначе любой юзер в личке вытянул бы operational-метрики через /health.
delete process.env.ADMIN_USER_ID;
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.TELEGRAM_CHANNEL_ID ??= "test-channel";
process.env.TOKEN_ENCRYPTION_KEY ??= "test-key";
process.env.POSTGRES_USERS_DSN ??= "postgres://test/test";
process.env.POSTGRES_CACHE_DSN ??= "postgres://test/test";
process.env.BOT_API_BASE_URL ??= "http://127.0.0.1:8081/bot";

import { isAdmin } from "../src/bot/handlers/admin.ts";

test("isAdmin — fail-closed без ADMIN_USER_ID: никто не админ, даже id=0", () => {
  assert.equal(isAdmin(0), false);
  assert.equal(isAdmin(1), false);
  assert.equal(isAdmin(-1), false);
});
