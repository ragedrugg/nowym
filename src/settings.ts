// pm2/ecosystem.config.cjs уже грузит .env через node --env-file — тут только
// фолбэк на прямой запуск (npm run start без pm2). process.loadEnvFile, как и
// dotenv, не перезаписывает уже заданные переменные; нет .env — не ошибка.
// Под тестами (NODE_ENV=test, см. test/setup.ts) .env не читаем вообще: иначе
// боевые значения из локального .env подменяют тестовые.
if (process.env.NODE_ENV !== "test") {
  try {
    process.loadEnvFile();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

type Env = NodeJS.ProcessEnv;

// Пустая/пробельная переменная = не задана → дефолт. Мусор → ошибка с именем
// переменной; значение в сообщение НЕ попадает (может оказаться секретом).
function envInt(e: Env, name: string, def: string): number {
  const raw = (e[name] ?? "").trim() || def;
  if (!/^[+-]?\d+$/.test(raw)) throw new Error(`${name} должен быть целым числом (значение не показано)`);
  return Number(raw);
}

function envFloat(e: Env, name: string, def: string): number {
  const raw = (e[name] ?? "").trim() || def;
  const n = Number(raw);
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(n)) {
    throw new Error(`${name} должен быть числом (значение не показано)`);
  }
  return n;
}

function env(e: Env, name: string, def = ""): string {
  return e[name] ?? def;
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

  /** пусто = ioredis-дефолт (127.0.0.1:6379). Нужно задать при запуске через
   * docker-compose, где redis — отдельный контейнер (REDIS_HOST=redis). */
  REDIS_HOST: string;
  REDIS_PORT: number;

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
  /** long-polling: сколько секунд без завершённого getUpdates до вмешательства
   *  сторожа (bot/pollingWatchdog.ts); 0 — сторож выключен. */
  POLLING_STALL_SEC: number;
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

  /** webhook-режим (BOT_API_BASE_URL пуст) и WEBHOOK_SECRET пуст: бот стартует,
   * но main.ts обязан логировать ERROR и отвечать 401 на webhook POST. */
  webhookSecretMissing: boolean;
}

/** Собирает и валидирует настройки из переданного env (для тестов). */
export function buildSettings(e: Env): Settings {
  const envInt_ = (n: string, d: string) => envInt(e, n, d);
  const envFloat_ = (n: string, d: string) => envFloat(e, n, d);
  const env_ = (n: string, d = "") => env(e, n, d);
  const ADMIN_USER_ID = envInt_("ADMIN_USER_ID", "0");

  const s: Settings = {
    API_TOKEN: env_("TELEGRAM_BOT_TOKEN"),
    TELEGRAM_CHANNEL_ID: env_("TELEGRAM_CHANNEL_ID"),
    ADMIN_USER_ID,

    POSTGRES_USERS_DSN: env_("POSTGRES_USERS_DSN"),
    POSTGRES_CACHE_DSN: env_("POSTGRES_CACHE_DSN"),
    DB_POOL_MIN: envInt_("DB_POOL_MIN", "1"),
    DB_POOL_MAX: envInt_("DB_POOL_MAX", "5"),

    TOKEN_ENCRYPTION_KEY: env_("TOKEN_ENCRYPTION_KEY"),

    REDIS_HOST: env_("REDIS_HOST"),
    REDIS_PORT: envInt_("REDIS_PORT", "6379"),

    LOG_LEVEL: env_("LOG_LEVEL", "INFO").toUpperCase(),
    LOG_FORMAT: env_("LOG_FORMAT", "human").toLowerCase(),

    // старые имена ADVANCED_CACHE_* — backward-compat с уже заполненными .env
    MEMORY_CACHE_SIZE: envInt_("MEMORY_CACHE_SIZE", env_("ADVANCED_CACHE_SIZE", "500")),
    MEMORY_CACHE_TTL: envInt_("MEMORY_CACHE_TTL", env_("ADVANCED_CACHE_TTL", "600")),
    CACHE_CLEANUP_INTERVAL: envInt_("CACHE_CLEANUP_INTERVAL", "60"),

    MAX_SEARCH_RESULTS: envInt_("MAX_SEARCH_RESULTS", "5"),

    HTTP_CONNECTION_LIMIT: envInt_("HTTP_CONNECTION_LIMIT", "100"),
    HTTP_LIMIT_PER_HOST: envInt_("HTTP_LIMIT_PER_HOST", "30"),

    YANDEX_RATE_LIMIT_INTERVAL: envFloat_("YANDEX_RATE_LIMIT_INTERVAL", "1.0"),
    YANDEX_MAX_RETRIES: envInt_("YANDEX_MAX_RETRIES", "3"),
    YANDEX_OAUTH_CLIENT_ID: env_("YANDEX_OAUTH_CLIENT_ID", "23cabbbdc6cd418abb4b39c32c41195d"),
    YANDEX_OAUTH_CLIENT_SECRET: env_("YANDEX_OAUTH_CLIENT_SECRET", "53bc75238f0c4d08a118e51fe9203300"),

    DOWNLOAD_QUEUE_CONCURRENCY: envInt_("DOWNLOAD_QUEUE_CONCURRENCY", "6"),
    ALBUM_PARALLEL_TRACKS: envInt_("ALBUM_PARALLEL_TRACKS", "4"),

    RATE_INLINE_MAX_TOKENS: envFloat_("RATE_INLINE_MAX_TOKENS", "20.0"),
    RATE_INLINE_RATE_PER_SEC: envFloat_("RATE_INLINE_RATE_PER_SEC", "2.0"),
    RATE_DOWNLOAD_MAX_TOKENS: envFloat_("RATE_DOWNLOAD_MAX_TOKENS", "3.0"),
    RATE_DOWNLOAD_RATE_PER_SEC: envFloat_("RATE_DOWNLOAD_RATE_PER_SEC", "0.1"),

    BOT_API_BASE_URL: env_("BOT_API_BASE_URL"),
    POLLING_STALL_SEC: envInt_("POLLING_STALL_SEC", "90"),
    WEBHOOK_HOST: env_("WEBHOOK_HOST"),
    WEBHOOK_PATH: env_("WEBHOOK_PATH", "/webhook/nowym"),
    WEBAPP_HOST: env_("WEBAPP_HOST", "0.0.0.0"),
    WEBAPP_PORT: envInt_("WEBAPP_PORT", "8443"),
    WEBHOOK_SSL_CERT: env_("WEBHOOK_SSL_CERT"),
    WEBHOOK_SSL_KEY: env_("WEBHOOK_SSL_KEY"),
    WEBHOOK_SECRET: env_("WEBHOOK_SECRET"),

    NOW_PLAYING_TOKEN: env_("NOW_PLAYING_TOKEN"),
    GENIUS_TOKEN: env_("GENIUS_TOKEN"),
    OWNER_ID: envInt_("OWNER_ID", String(ADMIN_USER_ID)),
    // Имя Telegram custom-emoji стикерпака для иконок кнопок (iconFor() в
    // bot/iconSet.ts резолвит эмодзи кнопки → custom_emoji_id из набора).
    // Дефолт "tgiosicons" — публичный пак, доступен любому боту без
    // настройки. Свой пак делается через @Stickers в Telegram (пункт
    // «Custom emoji» → создать/привязать к своему боту); непокрытые
    // эмодзи молча откатываются на обычный текстовый глиф.
    ICON_SET_NAME: env_("ICON_SET_NAME", "tgiosicons"),
    webhookSecretMissing: false,
  };
  s.webhookSecretMissing = !s.BOT_API_BASE_URL && !s.WEBHOOK_SECRET;

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
    if (!(val > 0)) throw new Error(`${name} должен быть > 0`);
  }
  for (const [name, val] of [
    ["WEBAPP_PORT", s.WEBAPP_PORT],
    ["REDIS_PORT", s.REDIS_PORT],
  ] as const) {
    if (!(val >= 1 && val <= 65535)) throw new Error(`${name} должен быть в диапазоне 1..65535`);
  }
  // getUpdates штатно висит до timeout(30s)+allowance(15s): порог ниже 60s рвал бы здоровый long-poll
  if (s.POLLING_STALL_SEC !== 0 && s.POLLING_STALL_SEC < 60) {
    throw new Error("POLLING_STALL_SEC должен быть 0 (выкл) или >= 60");
  }
  if (s.ADMIN_USER_ID < 0 || s.OWNER_ID < 0) throw new Error("ADMIN_USER_ID/OWNER_ID не могут быть отрицательными");
}

/** Ленивая инициализация — settings собираются и валидируются при первом
 * обращении, а не на импорте, чтобы юнит-тесты, не завязанные на env, не падали
 * на отсутствии TELEGRAM_BOT_TOKEN. */
let _cached: Settings | null = null;

export function getSettings(): Settings {
  if (_cached === null) _cached = buildSettings(process.env);
  return _cached;
}
