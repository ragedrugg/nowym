#!/bin/bash
# запускается postgres-образом автоматически (docker-entrypoint-initdb.d) при
# первом старте контейнера с пустым data-dir. Пароли — из env самого
# postgres-сервиса в docker-compose.yml (NOWSPOT_USERS_PASSWORD/NOWSPOT_CACHE_PASSWORD),
# те же значения должны быть у POSTGRES_USERS_DSN/POSTGRES_CACHE_DSN в .env бота.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE USER nowspot_users_app WITH PASSWORD '${NOWSPOT_USERS_PASSWORD}';
  CREATE USER nowspot_cache_app WITH PASSWORD '${NOWSPOT_CACHE_PASSWORD}';
  CREATE DATABASE nowspot_users OWNER nowspot_users_app;
  CREATE DATABASE nowspot_cache OWNER nowspot_cache_app;
EOSQL
