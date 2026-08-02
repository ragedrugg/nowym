import assert from "node:assert/strict";
import { test } from "node:test";

// ADMIN_USER_ID фиксируется settings.ts при первом getSettings() на весь процесс —
// задаём ДО любого импорта, который мог бы её дёрнуть раньше. Жёсткое `=`, не
// `??=`: тест сверяет конкретное значение, а в окружении с уже экспортированным
// реальным .env (напр. интерактивная разработка) `??=` тихо оставил бы боевой
// ADMIN_USER_ID вместо тестового. Fail-closed (без ADMIN_USER_ID) — отдельный
// файл adminFailClosed.test.ts, там же почему.
process.env.ADMIN_USER_ID = "12345";
process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
process.env.TELEGRAM_CHANNEL_ID ??= "test-channel";
process.env.TOKEN_ENCRYPTION_KEY ??= "test-key";
process.env.POSTGRES_USERS_DSN ??= "postgres://test/test";
process.env.POSTGRES_CACHE_DSN ??= "postgres://test/test";
process.env.BOT_API_BASE_URL ??= "http://127.0.0.1:8081/bot";

import { isAdmin } from "../src/bot/handlers/admin.ts";

test("isAdmin — true только для точного ADMIN_USER_ID", () => {
  assert.equal(isAdmin(12345), true);
  assert.equal(isAdmin(12346), false);
  assert.equal(isAdmin(0), false);
  assert.equal(isAdmin(-12345), false);
});
