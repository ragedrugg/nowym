// Preload для `npm test` (--import ./test/setup.ts): изоляция от боевого .env.
// NODE_ENV=test отключает loadDotenv в src/settings.ts; обязательные переменные
// задаём жёстким `=` (не `??=`), чтобы значения из окружения не просачивались.
// ADMIN_USER_ID намеренно не задаём (adminFailClosed.test.ts проверяет fail-closed).
process.env.NODE_ENV = "test";
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHANNEL_ID = "test-channel";
process.env.TOKEN_ENCRYPTION_KEY = "test-key";
process.env.POSTGRES_USERS_DSN = "postgres://test/test";
process.env.POSTGRES_CACHE_DSN = "postgres://test/test";
process.env.BOT_API_BASE_URL = "http://127.0.0.1:8081/bot";
delete process.env.ADMIN_USER_ID;
