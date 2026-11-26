#!/usr/bin/env bash
# бэкап nowym_users/nowym_cache — pg_dump (custom format) + ротация по возрасту
# + отправка дампов админу в личку. Крон-скрипт, к процессу бота не привязан
# (шлёт напрямую через Bot API, бот может быть в этот момент и не запущен).
#
#   ./scripts/backup.sh
#
# crontab -e (root, ежедневно):
#   59 20 * * * /home/rage/nowym/scripts/backup.sh >> /var/log/nowym-backup.log 2>&1
#
# восстановление: scripts/restore.sh <stamp> --yes (или вручную:
#   sudo -u postgres pg_restore -d nowym_users --clean --if-exists /var/backups/nowym/nowym_users-*.dump)
#
# переменные окружения (все опциональны):
#   NOWYM_BACKUP_DIR        каталог бэкапов (по умолчанию /var/backups/nowym)
#   NOWYM_BACKUP_KEEP_DAYS  срок хранения в днях (по умолчанию 14)
#   NOWYM_BACKUP_ENV=1      ДОПОЛНИТЕЛЬНО сложить копию .env (в нём TOKEN_ENCRYPTION_KEY)
#                           в $BACKUP_DIR/env-<stamp>, права 600, только локально,
#                           в Telegram НЕ уходит. По умолчанию выключено.
#   NOWYM_PG_MODE=docker    дампить через `docker compose exec -T postgres` вместо
#                           `sudo -u postgres pg_dump` (по умолчанию host)
#   NOWYM_BACKUP_LOCK       файл блокировки (по умолчанию /run/lock/nowym-backup.lock)
#   NOWYM_ENV_FILE          путь к .env (по умолчанию <корень репо>/.env)
#
# код возврата: 0 — дампы сняты и отправлены (или отправка не настроена);
# 1 — дамп не снялся/не прошёл проверку (тогда он переименовывается в *.unverified, а
# ротация старых бэкапов не выполняется), отправка в Telegram не удалась или уже
# идёт другой запуск. Локальные дампы при сбое отправки остаются.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${NOWYM_BACKUP_DIR:-/var/backups/nowym}"
KEEP_DAYS="${NOWYM_BACKUP_KEEP_DAYS:-14}"
ENV_FILE="${NOWYM_ENV_FILE:-$SCRIPT_DIR/.env}"
STAMP="$(date +%Y%m%d-%H%M%S)"

log() { echo "[$(date -Iseconds)] $*"; }
logerr() { echo "[$(date -Iseconds)] $*" >&2; }

# --- защита от параллельного запуска ---
LOCK_FILE="${NOWYM_BACKUP_LOCK:-/run/lock/nowym-backup.lock}"
if command -v flock >/dev/null 2>&1; then
  if ! { exec 9>"$LOCK_FILE"; } 2>/dev/null; then
    LOCK_FILE="${TMPDIR:-/tmp}/nowym-backup.lock"
    exec 9>"$LOCK_FILE"
  fi
  if ! flock -n 9; then
    logerr "другой запуск backup.sh ещё идёт (lock $LOCK_FILE) — выхожу"
    exit 1
  fi
else
  logerr "flock не найден — защита от параллельных запусков отключена"
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# --- чтение отдельных ключей из .env БЕЗ выполнения файла (никакого source/eval) ---
# last-wins, как у dotenv; поддержка export, "..."/'...' и хвостовых " # коммент"
# у значений без кавычек; & ? = $ ` внутри значения остаются как есть.
env_get() {
  local key="$1" line val found=""
  [ -f "$ENV_FILE" ] || return 0
  local re="^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=(.*)$"
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [[ $line =~ $re ]]; then
      val="${BASH_REMATCH[2]}"
      val="${val#"${val%%[![:space:]]*}"}"
      if [[ $val =~ ^\"(.*)\"[[:space:]]*(#.*)?$ ]]; then
        val="${BASH_REMATCH[1]}"
      elif [[ $val =~ ^\'(.*)\'[[:space:]]*(#.*)?$ ]]; then
        val="${BASH_REMATCH[1]}"
      else
        val="${val%%[[:space:]]#*}"
        val="${val%"${val##*[![:space:]]}"}"
      fi
      found="$val"
    fi
  done <"$ENV_FILE"
  printf '%s' "$found"
}

# --- дампы ---
failed=0
dumps=()
expected_dumps=2
have_restore=1
if ! command -v pg_restore >/dev/null 2>&1; then
  have_restore=0
  logerr "pg_restore не найден — проверка дампов пропущена (не ошибка)"
fi
for db in nowym_users nowym_cache; do
  file="$BACKUP_DIR/${db}-${STAMP}.dump"
  if [ "${NOWYM_PG_MODE:-host}" = "docker" ]; then
    dump_cmd=(docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T postgres pg_dump -U postgres -Fc "$db")
  else
    dump_cmd=(sudo -u postgres pg_dump -Fc "$db")
  fi
  if ! "${dump_cmd[@]}" >"$file"; then
    logerr "дамп $db не снялся — недописанный файл удаляю"
    rm -f "$file"
    failed=1
  elif [ "$have_restore" = 1 ] && ! pg_restore --list "$file" >/dev/null; then
    # никогда не удаляем снятый дамп: он может оказаться единственной копией
    logerr "дамп $db не прошёл pg_restore --list — переименован в $(basename "$file").unverified"
    mv -f "$file" "$file.unverified"
    chmod 600 "$file.unverified"
    failed=1
  else
    chmod 600 "$file"
    dumps+=("$file")
  fi
done

# --- опциональная копия .env (только локально, 600) ---
if [ "${NOWYM_BACKUP_ENV:-0}" = "1" ]; then
  if [ -f "$ENV_FILE" ]; then
    cp "$ENV_FILE" "$BACKUP_DIR/env-${STAMP}"
    chmod 600 "$BACKUP_DIR/env-${STAMP}"
    log "копия .env сохранена локально: $BACKUP_DIR/env-${STAMP} (в Telegram не отправляется)"
  else
    logerr "NOWYM_BACKUP_ENV=1, но $ENV_FILE не найден"
  fi
fi

if [ "${#dumps[@]}" -gt 0 ]; then
  log "бэкап готов: $BACKUP_DIR/*-${STAMP}.dump"
fi

# --- доставка в личку: сбой отправки -> ненулевой код (дампы на диске остаются) ---
# значение из .env главнее, как было при source; нет в .env — берём из окружения cron
_v="$(env_get TELEGRAM_BOT_TOKEN)"; TELEGRAM_BOT_TOKEN="${_v:-${TELEGRAM_BOT_TOKEN:-}}"
_v="$(env_get ADMIN_USER_ID)"; ADMIN_USER_ID="${_v:-${ADMIN_USER_ID:-}}"
_v="$(env_get BOT_API_BASE_URL)"; BOT_API_BASE_URL="${_v:-${BOT_API_BASE_URL:-}}"

if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$ADMIN_USER_ID" ]; then
  # self-hosted Bot API сервер (BOT_API_BASE_URL) — лимит на файл 2ГБ, не 50МБ
  # как в облаке; URL уже с /bot на конце, токен доклеивается сюда же.
  api_url="${BOT_API_BASE_URL:-https://api.telegram.org/bot}${TELEGRAM_BOT_TOKEN}"
  # URL кладём в curl-конфиг на stdin (в argv/ps токена нет); значения с кавычкой,
  # пробелом или переводом строки в конфиге сломали бы разбор — отсекаем.
  if [[ $api_url =~ ^https?://[^[:space:]\"\\]+$ ]] && [[ $ADMIN_USER_ID =~ ^-?[0-9]+$ ]]; then
    for file in "${dumps[@]}"; do
      code="$(printf 'url = "%s/sendDocument"\n' "$api_url" | curl --config - -sS -o /dev/null \
        --connect-timeout 20 --max-time 1800 -w '%{http_code}' -X POST \
        -F "chat_id=${ADMIN_USER_ID}" \
        -F "document=@${file}" \
        -F "caption=$(basename "$file")")" || code="000"
      if [ "$code" = "200" ]; then
        log "отправлено админу: $(basename "$file")"
      else
        logerr "не смог отправить админу: $(basename "$file") (http $code)"
        failed=1
      fi
    done
  else
    logerr "TELEGRAM_BOT_TOKEN/BOT_API_BASE_URL/ADMIN_USER_ID имеют недопустимый формат — в личку не шлю"
    failed=1
  fi
else
  log "TELEGRAM_BOT_TOKEN/ADMIN_USER_ID не найдены в .env — в личку не шлю"
fi

# --- ротация: ТОЛЬКО после полностью успешного запуска (ни одного сбоя дампа/проверки/
# отправки и ровно expected_dumps свежих дампов), иначе при постоянных сбоях через
# KEEP_DAYS дней пропали бы все хорошие бэкапы. *.dump.unverified (дамп не прошёл
# pg_restore --list) живут по тому же правилу возраста: удаляются только в успешный
# запуск, когда уже есть свежие проверенные дампы.
if [ "$failed" -eq 0 ] && [ "${#dumps[@]}" -eq "$expected_dumps" ]; then
  find "$BACKUP_DIR" -type f \( -name '*.dump' -o -name '*.dump.unverified' -o -name 'env-*' \) -mtime "+${KEEP_DAYS}" -delete
else
  logerr "ротация пропущена (сбой или снято дампов: ${#dumps[@]}/$expected_dumps) — старые бэкапы сохранены"
fi

exit "$failed"
