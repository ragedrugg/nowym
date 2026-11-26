#!/usr/bin/env bash
# откат КОДА на предыдущую копию дерева (схема БД аддитивная, старый код работает
# на новой схеме). Данные БД этот скрипт не трогает — для них scripts/restore.sh.
#
#   sudo scripts/rollback.sh <STAMP>
#
# ожидает рядом с рабочим деревом копию, сделанную перед деплоем:
#   PM2:    $NOWYM_APP_DIR.prev-<STAMP>   (по умолчанию /home/rage/nowym.prev-<STAMP>)
#   docker: образ nowym-bot:prev-<STAMP>
# режим docker определяется автоматически (docker compose ps -q bot).
#
# переменные: NOWYM_APP_DIR (/home/rage/nowym), NOWYM_PM2_NAME (nowym-ts),
# NOWYM_PM2_USER (по умолчанию пусто: pm2 запускается от текущего пользователя, на
# проде это root с PM2_HOME=/root/.pm2; задайте имя, чтобы под root вызывать
# `sudo -u <имя> pm2`), NOWYM_HEALTH_URL (https/http URL; по умолчанию
# http://127.0.0.1:8443/health — на проде порт под TLS, задайте https://...).
# NOWYM_HEALTH_CURL_OPTS — доп. ключи curl (например -k для самоподписанного TLS).
set -euo pipefail

APP_DIR="${NOWYM_APP_DIR:-/home/rage/nowym}"
PM2_NAME="${NOWYM_PM2_NAME:-nowym-ts}"
PM2_USER="${NOWYM_PM2_USER:-}"
HEALTH_URL="${NOWYM_HEALTH_URL:-http://127.0.0.1:8443/health}"
HEALTH_CURL_OPTS="${NOWYM_HEALTH_CURL_OPTS:-}"

die() { echo "rollback: $*" >&2; exit 1; }
[ $# -eq 1 ] && [[ $1 =~ ^[A-Za-z0-9._-]+$ ]] || { echo "usage: $0 <STAMP>" >&2; exit 2; }
STAMP="$1"
PREV="${APP_DIR}.prev-${STAMP}"

pm2u() {
  if [ -n "$PM2_USER" ] && [ "$(id -u)" -eq 0 ]; then
    sudo -u "$PM2_USER" pm2 "$@"
  elif [ "$(id -u)" -eq 0 ]; then
    PM2_HOME="${PM2_HOME:-/root/.pm2}" pm2 "$@"   # pm2 прода работает от root
  else
    pm2 "$@"
  fi
}

health() {
  local i
  for i in 1 2 3 4 5 6; do
    if curl -fsS --max-time 5 $HEALTH_CURL_OPTS "$HEALTH_URL"; then echo; echo "health: OK"; return 0; fi
    sleep 5
  done
  echo "health: НЕ ответил на $HEALTH_URL" >&2
  return 1
}

if command -v docker >/dev/null 2>&1 && [ -n "$(cd "$APP_DIR" && docker compose ps -q bot 2>/dev/null || true)" ]; then
  docker image inspect "nowym-bot:prev-${STAMP}" >/dev/null 2>&1 || die "нет образа nowym-bot:prev-${STAMP}"
  docker tag "nowym-bot:prev-${STAMP}" nowym-bot:latest
  (cd "$APP_DIR" && docker compose up -d --no-build bot)
else
  [ -d "$PREV" ] || die "нет каталога $PREV — откатывать не на что"
  failed="${APP_DIR}.failed-$(date +%s)"
  fresh="${APP_DIR}.rollback-new-$$"
  # безопасный порядок: сначала готовим копию рядом, переименовываем в последнюю
  # очередь; если cp/mv упали, живой каталог остаётся на месте (или возвращается).
  rm -rf "$fresh"
  cp -a "$PREV" "$fresh" || { rm -rf "$fresh"; die "не удалось скопировать $PREV — ничего не менял"; }
  pm2u stop "$PM2_NAME" || true
  mv "$APP_DIR" "$failed" || { rm -rf "$fresh"; die "не удалось переименовать $APP_DIR"; }
  if ! mv "$fresh" "$APP_DIR"; then
    mv "$failed" "$APP_DIR" || true
    die "не удалось поставить откатное дерево — исходный каталог возвращён"
  fi
  (cd "$APP_DIR" && pm2u start ecosystem.config.cjs && pm2u save)
  echo "неудачное дерево сохранено: $failed"
fi

health
