#!/usr/bin/env bash
# бэкап nowym_users/nowym_cache — pg_dump (custom format) + ротация по возрасту.
# Крон-скрипт, к процессу бота не привязан.
#
#   ./scripts/backup.sh
#
# crontab -e (root, ежедневно в 4 утра):
#   0 4 * * * /home/rage/nowym/scripts/backup.sh >> /var/log/nowym-backup.log 2>&1
#
# восстановление:
#   sudo -u postgres pg_restore -d nowym_users --clean --if-exists /var/backups/nowym/nowym_users-*.dump
set -euo pipefail

BACKUP_DIR="${NOWYM_BACKUP_DIR:-/var/backups/nowym}"
KEEP_DAYS="${NOWYM_BACKUP_KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

for db in nowym_users nowym_cache; do
  sudo -u postgres pg_dump -Fc "$db" >"$BACKUP_DIR/${db}-${STAMP}.dump"
done

find "$BACKUP_DIR" -name '*.dump' -mtime "+${KEEP_DAYS}" -delete

echo "[$(date -Iseconds)] бэкап готов: $BACKUP_DIR/*-${STAMP}.dump"
