import { config as loadDotenv } from "dotenv";

loadDotenv();

function envInt(name: string, def: string): number {
  return parseInt(process.env[name] ?? def, 10);
}

function envFloat(name: string, def: string): number {
  return parseFloat(process.env[name] ?? def);
}

function env(name: string, def = ""): string {
  return process.env[name] ?? def;
}

const LOG_LEVELS = new Set(["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]);

export interface Settings {
  API_TOKEN: string;
  TELEGRAM_CHANNEL_ID: string;
  ADMIN_USER_ID: number;

  POSTGRES_USERS_DSN: string;
  POSTGRES_CACHE_DSN: string;
  DB_POOL_MIN: number;
  DB_POOL_MAX: number;

  TOKEN_ENCRYPTION_KEY: string;

  LOG_LEVEL: string;
  LOG_FORMAT: string;

  MEMORY_CACHE_SIZE: number;
  MEMORY_CACHE_TTL: number;
  CACHE_CLEANUP_INTERVAL: number;

  MAX_SEARCH_RESULTS: number;

  HTTP_CONNECTION_LIMIT: number;
  HTTP_LIMIT_PER_HOST: number;

  YANDEX_RATE_LIMIT_INTERVAL: number;
  YANDEX_MAX_RETRIES: number;
  YANDEX_OAUTH_CLIENT_ID: string;
  YANDEX_OAUTH_CLIENT_SECRET: string;

  DOWNLOAD_QUEUE_CONCURRENCY: number;
  ALBUM_PARALLEL_TRACKS: number;

  RATE_INLINE_MAX_TOKENS: number;
  RATE_INLINE_RATE_PER_SEC: number;
  RATE_DOWNLOAD_MAX_TOKENS: number;
  RATE_DOWNLOAD_RATE_PER_SEC: number;

  /** baseURL self-hosted Bot API server (напр. http://127.0.0.1:8081/bot).
   *  Пусто → облако api.telegram.org + webhook. Задано → local server + long-polling. */
  BOT_API_BASE_URL: string;
  WEBHOOK_HOST: string;
  WEBHOOK_PATH: string;
  WEBAPP_HOST: string;
  WEBAPP_PORT: number;
  WEBHOOK_SSL_CERT: string;
  WEBHOOK_SSL_KEY: string;
  WEBHOOK_SECRET: string;

  NOW_PLAYING_TOKEN: string;
  GENIUS_TOKEN: string;
  OWNER_ID: number;
  ICON_SET_NAME: string;
}

function build(): Settings {
  const ADMIN_USER_ID = envInt("ADMIN_USER_ID", "0");

  const s: Settings = {
    API_TOKEN: env("TELEGRAM_BOT_TOKEN"),
    TELEGRAM_CHANNEL_ID: env("TELEGRAM_CHANNEL_ID"),
    ADMIN_USER_ID,

    POSTGRES_USERS_DSN: env("POSTGRES_USERS_DSN"),
    POSTGRES_CACHE_DSN: env("POSTGRES_CACHE_DSN"),
    DB_POOL_MIN: envInt("DB_POOL_MIN", "1"),
    DB_POOL_MAX: envInt("DB_POOL_MAX", "5"),

    TOKEN_ENCRYPTION_KEY: env("TOKEN_ENCRYPTION_KEY"),

    LOG_LEVEL: env("LOG_LEVEL", "INFO").toUpperCase(),
    LOG_FORMAT: env("LOG_FORMAT", "human").toLowerCase(),

    // старые имена ADVANCED_CACHE_* — backward-compat с уже заполненными .env
    MEMORY_CACHE_SIZE: envInt("MEMORY_CACHE_SIZE", env("ADVANCED_CACHE_SIZE", "500")),
    MEMORY_CACHE_TTL: envInt("MEMORY_CACHE_TTL", env("ADVANCED_CACHE_TTL", "600")),
    CACHE_CLEANUP_INTERVAL: envInt("CACHE_CLEANUP_INTERVAL", "60"),

    MAX_SEARCH_RESULTS: envInt("MAX_SEARCH_RESULTS", "5"),

    HTTP_CONNECTION_LIMIT: envInt("HTTP_CONNECTION_LIMIT", "100"),
    HTTP_LIMIT_PER_HOST: envInt("HTTP_LIMIT_PER_HOST", "30"),

    YANDEX_RATE_LIMIT_INTERVAL: envFloat("YANDEX_RATE_LIMIT_INTERVAL", "1.0"),
    YANDEX_MAX_RETRIES: envInt("YANDEX_MAX_RETRIES", "3"),
    YANDEX_OAUTH_CLIENT_ID: env("YANDEX_OAUTH_CLIENT_ID", "23cabbbdc6cd418abb4b39c32c41195d"),
    YANDEX_OAUTH_CLIENT_SECRET: env("YANDEX_OAUTH_CLIENT_SECRET", "53bc75238f0c4d08a118e51fe9203300"),

    DOWNLOAD_QUEUE_CONCURRENCY: envInt("DOWNLOAD_QUEUE_CONCURRENCY", "6"),
    ALBUM_PARALLEL_TRACKS: envInt("ALBUM_PARALLEL_TRACKS", "4"),

    RATE_INLINE_MAX_TOKENS: envFloat("RATE_INLINE_MAX_TOKENS", "20.0"),
    RATE_INLINE_RATE_PER_SEC: envFloat("RATE_INLINE_RATE_PER_SEC", "2.0"),
    RATE_DOWNLOAD_MAX_TOKENS: envFloat("RATE_DOWNLOAD_MAX_TOKENS", "3.0"),
    RATE_DOWNLOAD_RATE_PER_SEC: envFloat("RATE_DOWNLOAD_RATE_PER_SEC", "0.1"),

    BOT_API_BASE_URL: env("BOT_API_BASE_URL"),
    WEBHOOK_HOST: env("WEBHOOK_HOST"),
    WEBHOOK_PATH: env("WEBHOOK_PATH", "/webhook/nowym"),
    WEBAPP_HOST: env("WEBAPP_HOST", "0.0.0.0"),
    WEBAPP_PORT: envInt("WEBAPP_PORT", "8443"),
    WEBHOOK_SSL_CERT: env("WEBHOOK_SSL_CERT"),
    WEBHOOK_SSL_KEY: env("WEBHOOK_SSL_KEY"),
    WEBHOOK_SECRET: env("WEBHOOK_SECRET"),

    NOW_PLAYING_TOKEN: env("NOW_PLAYING_TOKEN"),
    GENIUS_TOKEN: env("GENIUS_TOKEN"),
    OWNER_ID: envInt("OWNER_ID", String(ADMIN_USER_ID)),
    // Имя Telegram custom-emoji стикерпака для иконок кнопок (iconFor() в
    // bot/iconSet.ts резолвит эмодзи кнопки → custom_emoji_id из набора).
    // Дефолт "tgiosicons" — публичный пак, доступен любому боту без
    // настройки. Свой пак делается через @Stickers в Telegram (пункт
    // «Custom emoji» → создать/привязать к своему боту); непокрытые
    // эмодзи молча откатываются на обычный текстовый глиф.
    ICON_SET_NAME: env("ICON_SET_NAME", "tgiosicons"),
  };

  validate(s);
  return s;
}

function validate(s: Settings): void {
  const required: [string, string][] = [
    ["TELEGRAM_BOT_TOKEN", s.API_TOKEN],
    ["TELEGRAM_CHANNEL_ID", s.TELEGRAM_CHANNEL_ID],
    ["TOKEN_ENCRYPTION_KEY", s.TOKEN_ENCRYPTION_KEY],
    ["POSTGRES_USERS_DSN", s.POSTGRES_USERS_DSN],
    ["POSTGRES_CACHE_DSN", s.POSTGRES_CACHE_DSN],
  ];
  for (const [name, val] of required) {
    if (!val) throw new Error(`${name} не задан в .env`);
  }

  // BOT_API_BASE_URL пуст → main.ts выбирает webhook-режим, которому нужен
  // публичный домен. Без этой проверки бот тратит ~90с на ретраи setWebhook
  // с невнятной ошибкой от Telegram вместо понятного фейла на старте.
  if (!s.BOT_API_BASE_URL && !s.WEBHOOK_HOST) {
    throw new Error(
      "ни BOT_API_BASE_URL, ни WEBHOOK_HOST не заданы в .env — нечем подключаться к Telegram. " +
        "Либо self-hosted Bot API сервер (BOT_API_BASE_URL, long-polling, без домена), " +
        "либо облачный webhook (WEBHOOK_HOST + TLS-серты). См. README.",
    );
  }

  if (!LOG_LEVELS.has(s.LOG_LEVEL)) {
    throw new Error(`LOG_LEVEL=${JSON.stringify(s.LOG_LEVEL)} кривой`);
  }
  if (s.LOG_FORMAT !== "human" && s.LOG_FORMAT !== "json") {
    throw new Error(`LOG_FORMAT=${JSON.stringify(s.LOG_FORMAT)} кривой (human/json)`);
  }

  const positive: [string, number][] = [
    ["MAX_SEARCH_RESULTS", s.MAX_SEARCH_RESULTS],
    ["DB_POOL_MAX", s.DB_POOL_MAX],
    ["DOWNLOAD_QUEUE_CONCURRENCY", s.DOWNLOAD_QUEUE_CONCURRENCY],
    ["ALBUM_PARALLEL_TRACKS", s.ALBUM_PARALLEL_TRACKS],
  ];
  for (const [name, val] of positive) {
    if (val <= 0) throw new Error(`${name} должен быть > 0`);
  }
}

/** Ленивая инициализация — settings собираются и валидируются при первом
 * обращении, а не на импорте, чтобы юнит-тесты, не завязанные на env, не падали
 * на отсутствии TELEGRAM_BOT_TOKEN. */
let _cached: Settings | null = null;

export function getSettings(): Settings {
  if (_cached === null) _cached = build();
  return _cached;
}
