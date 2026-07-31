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
# восстановление:
#   sudo -u postgres pg_restore -d nowym_users --clean --if-exists /var/backups/nowym/nowym_users-*.dump
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${NOWYM_BACKUP_DIR:-/var/backups/nowym}"
KEEP_DAYS="${NOWYM_BACKUP_KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

dumps=()
for db in nowym_users nowym_cache; do
  file="$BACKUP_DIR/${db}-${STAMP}.dump"
  sudo -u postgres pg_dump -Fc "$db" >"$file"
  dumps+=("$file")
done

find "$BACKUP_DIR" -name '*.dump' -mtime "+${KEEP_DAYS}" -delete

echo "[$(date -Iseconds)] бэкап готов: $BACKUP_DIR/*-${STAMP}.dump"

# доставка в личку — best-effort, сбой отправки не должен ронять сам бэкап
# (дампы на диске уже целы независимо от Telegram).
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${ADMIN_USER_ID:-}" ]; then
  # self-hosted Bot API сервер (BOT_API_BASE_URL) — лимит на файл 2ГБ, не 50МБ
  # как в облаке; URL уже с /bot на конце, токен доклеивается сюда же.
  api_url="${BOT_API_BASE_URL:-https://api.telegram.org/bot}${TELEGRAM_BOT_TOKEN}"
  for file in "${dumps[@]}"; do
    if curl -sS -o /dev/null -w "%{http_code}" -X POST "${api_url}/sendDocument" \
      -F "chat_id=${ADMIN_USER_ID}" \
      -F "document=@${file}" \
      -F "caption=$(basename "$file")" | grep -q "^200$"; then
      echo "[$(date -Iseconds)] отправлено админу: $(basename "$file")"
    else
      echo "[$(date -Iseconds)] не смог отправить админу: $(basename "$file")" >&2
    fi
  done
else
  echo "[$(date -Iseconds)] TELEGRAM_BOT_TOKEN/ADMIN_USER_ID не найдены в .env — в личку не шлю"
fi
