-- Создание двух изолированных БД для nowym.
-- ПЕРЕД ЗАПУСКОМ: подставь свои пароли вместо CHANGE_ME_USERS / CHANGE_ME_CACHE.
-- Запуск: sudo -u postgres psql -f docs/sql/init.sql

CREATE USER nowym_users_app WITH PASSWORD 'CHANGE_ME_USERS';
CREATE USER nowym_cache_app WITH PASSWORD 'CHANGE_ME_CACHE';

CREATE DATABASE nowym_users OWNER nowym_users_app;
CREATE DATABASE nowym_cache OWNER nowym_cache_app;

-- Схема таблиц создаётся автоматически при первом старте бота
-- (см. src/storage/users.ts::initSchema и src/storage/cache.ts::initSchema).
