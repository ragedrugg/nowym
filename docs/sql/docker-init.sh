#!/bin/bash
# запускается postgres-образом автоматически (docker-entrypoint-initdb.d) при
# первом старте контейнера с пустым data-dir. Пароли — из env самого
# postgres-сервиса в docker-compose.yml (NOWYM_USERS_PASSWORD/NOWYM_CACHE_PASSWORD),
# те же значения должны быть у POSTGRES_USERS_DSN/POSTGRES_CACHE_DSN в .env бота.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE USER nowym_users_app WITH PASSWORD '${NOWYM_USERS_PASSWORD}';
  CREATE USER nowym_cache_app WITH PASSWORD '${NOWYM_CACHE_PASSWORD}';
  CREATE DATABASE nowym_users OWNER nowym_users_app;
  CREATE DATABASE nowym_cache OWNER nowym_cache_app;
EOSQL
