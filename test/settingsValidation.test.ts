/** buildSettings: строгий разбор числовых env, prod-набор, webhookSecretMissing; secretMatches. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { secretMatches } from "../src/infra/secret.ts";
import { buildSettings } from "../src/settings.ts";

const prodEnv = (): NodeJS.ProcessEnv => ({
  TELEGRAM_BOT_TOKEN: "dummy-token",
  TELEGRAM_CHANNEL_ID: "-1001234567890",
  ADMIN_USER_ID: "123456789",
  POSTGRES_USERS_DSN: "postgres://u:p@127.0.0.1/users",
  POSTGRES_CACHE_DSN: "postgres://u:p@127.0.0.1/cache",
  TOKEN_ENCRYPTION_KEY: "dummy-key",
  DB_POOL_MIN: "1",
  DB_POOL_MAX: "5",
  LOG_LEVEL: "INFO",
  LOG_FORMAT: "human",
  MEMORY_CACHE_SIZE: "500",
  MEMORY_CACHE_TTL: "600",
  CACHE_CLEANUP_INTERVAL: "60",
  MAX_SEARCH_RESULTS: "5",
  HTTP_LIMIT_PER_HOST: "30",
  YANDEX_RATE_LIMIT_INTERVAL: "1.0",
  YANDEX_MAX_RETRIES: "3",
  DOWNLOAD_QUEUE_CONCURRENCY: "6",
  ALBUM_PARALLEL_TRACKS: "4",
  RATE_INLINE_RATE_PER_SEC: "2.0",
  RATE_DOWNLOAD_RATE_PER_SEC: "0.1",
  RATE_INLINE_MAX_TOKENS: "20.0",
  RATE_DOWNLOAD_MAX_TOKENS: "3.0",
  WEBAPP_PORT: "8443",
  WEBAPP_HOST: "0.0.0.0",
  BOT_API_BASE_URL: "http://127.0.0.1:8081/bot",
  WEBHOOK_HOST: "example.org",
  WEBHOOK_PATH: "/webhook/x",
  WEBHOOK_SSL_CERT: "/c.pem",
  WEBHOOK_SSL_KEY: "/k.pem",
  WEBHOOK_SECRET: "dummy-secret",
  ICON_SET_NAME: "",
});

test("prod-набор env проходит валидацию", () => {
  const s = buildSettings(prodEnv());
  assert.equal(s.ADMIN_USER_ID, 123456789);
  assert.equal(s.RATE_DOWNLOAD_RATE_PER_SEC, 0.1);
  assert.equal(s.REDIS_PORT, 6379);
  assert.equal(s.webhookSecretMissing, false);
});

const numericVars = [
  "ADMIN_USER_ID",
  "OWNER_ID",
  "DB_POOL_MIN",
  "DB_POOL_MAX",
  "REDIS_PORT",
  "MEMORY_CACHE_SIZE",
  "MEMORY_CACHE_TTL",
  "CACHE_CLEANUP_INTERVAL",
  "MAX_SEARCH_RESULTS",
  "HTTP_LIMIT_PER_HOST",
  "YANDEX_RATE_LIMIT_INTERVAL",
  "YANDEX_MAX_RETRIES",
  "DOWNLOAD_QUEUE_CONCURRENCY",
  "ALBUM_PARALLEL_TRACKS",
  "RATE_INLINE_MAX_TOKENS",
  "RATE_INLINE_RATE_PER_SEC",
  "RATE_DOWNLOAD_MAX_TOKENS",
  "RATE_DOWNLOAD_RATE_PER_SEC",
  "WEBAPP_PORT",
  "POLLING_STALL_SEC",
  "STALE_REFRESH_LIMIT",
];

for (const name of numericVars) {
  test(`${name}: мусор → ошибка с именем, без значения`, () => {
    const e = prodEnv();
    e[name] = "NaN-s3cret";
    assert.throws(
      () => buildSettings(e),
      (err: Error) => err.message.includes(name) && !err.message.includes("s3cret"),
    );
  });
  test(`${name}: пустое → дефолт`, () => {
    const e = prodEnv();
    e[name] = "";
    assert.doesNotThrow(() => buildSettings(e));
  });
}

test("POLLING_STALL_SEC: дефолт 90, 0 — выкл, 1..59 отклоняется", () => {
  assert.equal(buildSettings(prodEnv()).POLLING_STALL_SEC, 90);
  const e = prodEnv();
  e.POLLING_STALL_SEC = "0";
  assert.equal(buildSettings(e).POLLING_STALL_SEC, 0);
  e.POLLING_STALL_SEC = "30";
  assert.throws(() => buildSettings(e), /POLLING_STALL_SEC/);
  e.POLLING_STALL_SEC = "120";
  assert.equal(buildSettings(e).POLLING_STALL_SEC, 120);
});

test("R7: STALE_REFRESH_LIMIT: дефолт 50, 0 — выкл, отрицательное отклоняется", () => {
  assert.equal(buildSettings(prodEnv()).STALE_REFRESH_LIMIT, 50);
  const e = prodEnv();
  e.STALE_REFRESH_LIMIT = "0";
  assert.equal(buildSettings(e).STALE_REFRESH_LIMIT, 0);
  e.STALE_REFRESH_LIMIT = "-1";
  assert.throws(() => buildSettings(e), /STALE_REFRESH_LIMIT/);
});

test("ADMIN_USER_ID=NaN не отключает admin-гейт молча", () => {
  const e = prodEnv();
  e.ADMIN_USER_ID = "NaN";
  assert.throws(() => buildSettings(e), /ADMIN_USER_ID/);
});

test("webhook-режим без WEBHOOK_SECRET: старт разрешён, флаг поднят", () => {
  const e = prodEnv();
  delete e.BOT_API_BASE_URL;
  e.WEBHOOK_SECRET = "";
  assert.equal(buildSettings(e).webhookSecretMissing, true);
});

test("polling-режим без WEBHOOK_SECRET: флаг не поднят", () => {
  const e = prodEnv();
  e.WEBHOOK_SECRET = "";
  assert.equal(buildSettings(e).webhookSecretMissing, false);
});

test("secretMatches: fail closed при пустом expected", () => {
  assert.equal(secretMatches(undefined, ""), false);
  assert.equal(secretMatches("", ""), false);
  assert.equal(secretMatches("x", ""), false);
  assert.equal(secretMatches("abc", "abc"), true);
  assert.equal(secretMatches("abd", "abc"), false);
  assert.equal(secretMatches("ab", "abc"), false);
  assert.equal(secretMatches(undefined, "abc"), false);
});

test("D15: METRICS_TOKEN идёт через Settings (дефолт — пусто)", () => {
  assert.equal(buildSettings(prodEnv()).METRICS_TOKEN, "");
  assert.equal(buildSettings({ ...prodEnv(), METRICS_TOKEN: "m-tok" }).METRICS_TOKEN, "m-tok");
});
