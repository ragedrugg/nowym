#!/bin/bash
# запускается postgres-образом автоматически (docker-entrypoint-initdb.d) при
# первом старте контейнера с пустым data-dir. Пароли — из env самого
# postgres-сервиса в docker-compose.yml (NOWYM_USERS_PASSWORD/NOWYM_CACHE_PASSWORD),
# те же значения должны быть у POSTGRES_USERS_DSN/POSTGRES_CACHE_DSN в .env бота.
#
# Пароли передаются в psql как переменные (-v) и подставляются как :'имя' —
# psql сам экранирует литерал, кавычки/бэкслеши в пароле не ломают SQL.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v users_pw="$NOWYM_USERS_PASSWORD" -v cache_pw="$NOWYM_CACHE_PASSWORD" <<'EOSQL'
CREATE USER nowym_users_app WITH PASSWORD :'users_pw';
CREATE USER nowym_cache_app WITH PASSWORD :'cache_pw';
CREATE DATABASE nowym_users OWNER nowym_users_app;
CREATE DATABASE nowym_cache OWNER nowym_cache_app;
EOSQL
