-- Создание двух изолированных БД для nowspot.
-- ПЕРЕД ЗАПУСКОМ: подставь свои пароли вместо CHANGE_ME_USERS / CHANGE_ME_CACHE.
-- Запуск: sudo -u postgres psql -f docs/sql/init.sql

CREATE USER nowspot_users_app WITH PASSWORD 'CHANGE_ME_USERS';
CREATE USER nowspot_cache_app WITH PASSWORD 'CHANGE_ME_CACHE';

CREATE DATABASE nowspot_users OWNER nowspot_users_app;
CREATE DATABASE nowspot_cache OWNER nowspot_cache_app;

-- Схема таблиц создаётся автоматически при первом старте бота
-- (см. src/storage/users.ts::initSchema и src/storage/cache.ts::initSchema).
