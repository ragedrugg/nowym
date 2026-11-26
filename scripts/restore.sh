#!/usr/bin/env bash
# восстановление nowym_users/nowym_cache из дампов backup.sh.
#
#   scripts/restore.sh <stamp> [--db nowym_users|nowym_cache] [--yes]
#
#   <stamp>  часть имени файла после "nowym_users-"/"nowym_cache-" и до ".dump",
#            например 20261126-205900 или predeploy-20261126-120000
#   --db     восстановить только одну базу (по умолчанию обе)
#   --yes    без него скрипт только проверяет дампы и печатает план, ничего не меняя
#
# ДЕСТРУКТИВНО: pg_restore --clean --if-exists затирает текущие объекты в базе.
# Перед восстановлением бот останавливается (pm2 или docker compose, определяется
# автоматически) и НЕ запускается обратно — после проверки запусти руками.
#
# переменные: NOWYM_BACKUP_DIR (/var/backups/nowym), NOWYM_PG_MODE=docker,
# NOWYM_PM2_NAME (nowym-ts), NOWYM_PM2_USER (rage — владелец pm2).
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${NOWYM_BACKUP_DIR:-/var/backups/nowym}"
PM2_NAME="${NOWYM_PM2_NAME:-nowym-ts}"
PM2_USER="${NOWYM_PM2_USER:-rage}"

usage() { sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }
die() { echo "restore: $*" >&2; exit 1; }

stamp="" only_db="" yes=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) yes=1 ;;
    --db) shift; [ $# -gt 0 ] || usage; only_db="$1" ;;
    -h|--help) usage ;;
    -*) usage ;;
    *) [ -z "$stamp" ] || usage; stamp="$1" ;;
  esac
  shift
done
[ -n "$stamp" ] || usage
[[ $stamp =~ ^[A-Za-z0-9._-]+$ ]] || die "недопустимый stamp: $stamp"

case "$only_db" in
  "") dbs=(nowym_users nowym_cache) ;;
  nowym_users|nowym_cache) dbs=("$only_db") ;;
  *) die "--db: только nowym_users или nowym_cache" ;;
esac

# --- проверки до любых изменений ---
for db in "${dbs[@]}"; do
  f="$BACKUP_DIR/${db}-${stamp}.dump"
  [ -f "$f" ] || die "нет файла $f"
  pg_restore --list "$f" >/dev/null || die "$f не проходит pg_restore --list (битый дамп)"
done
echo "дампы найдены и читаются: ${dbs[*]} @ $stamp"

docker_mode=0
[ "${NOWYM_PG_MODE:-host}" = "docker" ] && docker_mode=1
dc() { docker compose -f "$SCRIPT_DIR/docker-compose.yml" "$@"; }

if [ "$yes" -ne 1 ]; then
  echo "это проверка. Для восстановления (ЗАТРЁТ текущие данные в ${dbs[*]}) добавь --yes"
  exit 2
fi

# --- останавливаем бота ---
bot_mode=none
if [ "$docker_mode" -eq 1 ] || { command -v docker >/dev/null 2>&1 && [ -n "$(dc ps -q bot 2>/dev/null || true)" ]; }; then
  bot_mode=docker
elif command -v pm2 >/dev/null 2>&1; then
  bot_mode=pm2
fi
case "$bot_mode" in
  docker) dc stop bot ;;
  pm2)
    if [ "$(id -u)" -eq 0 ] && [ -n "$PM2_USER" ]; then sudo -u "$PM2_USER" pm2 stop "$PM2_NAME" || true
    else pm2 stop "$PM2_NAME" || true; fi ;;
  *) echo "pm2/docker не найдены — убедись, что бот остановлен" >&2 ;;
esac

# --- восстановление (дамп подаём через stdin: у postgres нет доступа в 700-каталог) ---
for db in "${dbs[@]}"; do
  f="$BACKUP_DIR/${db}-${stamp}.dump"
  echo "восстанавливаю $db из $f"
  if [ "$docker_mode" -eq 1 ]; then
    dc exec -T postgres pg_restore -U postgres -d "$db" --clean --if-exists <"$f"
  else
    sudo -u postgres pg_restore -d "$db" --clean --if-exists <"$f"
  fi
done

echo "готово. Бот остановлен (режим: $bot_mode). Дальше:"
case "$bot_mode" in
  docker) echo "  docker compose up -d bot" ;;
  pm2) echo "  sudo -u $PM2_USER pm2 start $PM2_NAME   # затем: curl -fsS http://127.0.0.1:8443/health" ;;
  *) echo "  запусти бота" ;;
esac
