#!/usr/bin/env bash
# харнесс для backup.sh: stub-команды в PATH (pg_dump, pg_restore, sudo, flock, curl),
# временный каталог, ни БД, ни сети. Запуск: scripts/test-backup.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/out"
fails=0
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) NOPERM=1;; *) NOPERM=0;; esac # на Windows chmod/stat фиктивны
check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; fails=$((fails+1)); fi; }

cat >"$T/bin/sudo" <<'S'
#!/bin/sh
[ "$1" = "-u" ] && shift 2
exec "$@"
S
cat >"$T/bin/pg_dump" <<'S'
#!/bin/sh
[ -n "${FAKE_DUMP_FAIL:-}" ] && exit 2
echo "PGDMP-fake $*"
S
cat >"$T/bin/pg_restore" <<'S'
#!/bin/sh
[ -n "${FAKE_RESTORE_FAIL:-}" ] && exit 1
exit 0
S
cat >"$T/bin/flock" <<'S'
#!/bin/sh
[ -n "${FAKE_FLOCK_BUSY:-}" ] && exit 1
exit 0
S
cat >"$T/bin/curl" <<'S'
#!/bin/sh
echo "$*" >>"$FAKE_CURL_ARGV"
cat >>"$FAKE_CURL_STDIN"
printf '%s' "${FAKE_CURL_CODE:-200}"
S
chmod +x "$T"/bin/*
export FAKE_CURL_ARGV="$T/curl.argv" FAKE_CURL_STDIN="$T/curl.stdin"

cat >"$T/env" <<'E'
# comment
TELEGRAM_BOT_TOKEN="123456:AAE-secret_tok"   # trailing
ADMIN_USER_ID=424242
BOT_API_BASE_URL='http://127.0.0.1:8081/bot'
EVIL=$(touch PWNED)
OTHER=`touch PWNED2`
Q=a&b?c=d
E

run() { # run [VAR=val ...]
  rm -f "$T/curl.argv" "$T/curl.stdin"; rm -rf "$T/out"; : >"$T/log"
  ( cd "$T" && env PATH="$T/bin:$PATH" NOWYM_BACKUP_DIR="$T/out" NOWYM_ENV_FILE="$T/env" \
      NOWYM_BACKUP_LOCK="$T/lock" "$@" bash "$HERE/backup.sh" ) >"$T/log" 2>&1
}

run FAKE_CURL_CODE=200 && rc=0 || rc=$?
check "happy path exit 0" "[ $rc -eq 0 ]"
check "both dumps with expected names" "ls $T/out | grep -qE '^nowym_users-[0-9]{8}-[0-9]{6}\.dump$' && ls $T/out | grep -qE '^nowym_cache-[0-9]{8}-[0-9]{6}\.dump$'"
check "dump mode 600, dir 700" "[ $NOPERM -eq 1 ] || { [ \"\$(stat -c %a $T/out)\" = 700 ] && [ \"\$(stat -c %a $T/out/nowym_users-*.dump)\" = 600 ]; }"
check ".env not executed" "[ ! -e $T/PWNED ] && [ ! -e $T/PWNED2 ]"
check "token not in curl argv" "! grep -q 'AAE-secret_tok' $T/curl.argv"
check "token+base url in stdin config" "grep -q 'url = \"http://127.0.0.1:8081/bot123456:AAE-secret_tok/sendDocument\"' $T/curl.stdin"
check "2 uploads" "[ \$(wc -l <$T/curl.stdin) -eq 2 ]"
check "no .env copy by default" "! ls $T/out | grep -q '^env-'"
check "token not in log" "! grep -q 'AAE-secret_tok' $T/log"

run FAKE_CURL_CODE=500 && rc=0 || rc=$?
check "upload failure -> exit 1, dumps kept" "[ $rc -eq 1 ] && ls $T/out/*.dump | wc -l | grep -q 2"

run FAKE_DUMP_FAIL=1 && rc=0 || rc=$?
check "dump failure -> exit 1, no partial files" "[ $rc -eq 1 ] && [ -z \"\$(ls $T/out)\" ]"

run FAKE_FLOCK_BUSY=1 && rc=0 || rc=$?
check "overlap -> exit 1, nothing done" "[ $rc -eq 1 ] && [ ! -e $T/out ]"

run NOWYM_BACKUP_ENV=1 && rc=0 || rc=$?
check "opt-in .env copy mode 600, not uploaded" "{ [ $NOPERM -eq 1 ] || [ \"\$(stat -c %a $T/out/env-*)\" = 600 ]; } && [ -e $T/out/env-* ] && ! grep -q 'env-' $T/curl.argv"

# ротация: старые .dump и env-* удаляются, свежие остаются
rm -rf "$T/out"; mkdir -p "$T/out"
touch -d '20 days ago' "$T/out/nowym_users-old.dump" "$T/out/env-old"; touch "$T/out/env-new"
( cd "$T" && env PATH="$T/bin:$PATH" NOWYM_BACKUP_DIR="$T/out" NOWYM_ENV_FILE="$T/none" NOWYM_BACKUP_LOCK="$T/lock" bash "$HERE/backup.sh" ) >"$T/log" 2>&1 && rc=0 || rc=$?
check "rotation covers dump and env-*; no .env -> exit 0" "[ $rc -eq 0 ] && [ ! -e $T/out/nowym_users-old.dump ] && [ ! -e $T/out/env-old ] && [ -e $T/out/env-new ]"

# --- сбои не должны съедать старые бэкапы (ротация только после полностью успешного запуска) ---
seed_old() { # старые дампы в $T/out (run чистит каталог, поэтому сеем через NOWYM_SEED)
  mkdir -p "$T/out"
  touch -d '20 days ago' "$T/out/nowym_users-old.dump" "$T/out/nowym_cache-old.dump" "$T/out/nowym_users-old.dump.unverified"
}
run_seeded() { # run_seeded [VAR=val ...] — как run, но без очистки out/ и с посевом старья
  rm -f "$T/curl.argv" "$T/curl.stdin"; rm -rf "$T/out"; seed_old
  ( cd "$T" && env PATH="$T/bin:$PATH" NOWYM_BACKUP_DIR="$T/out" NOWYM_ENV_FILE="$T/env"       NOWYM_BACKUP_LOCK="$T/lock" "$@" bash "$HERE/backup.sh" ) >"$T/log" 2>&1
}
old_kept="[ -e $T/out/nowym_users-old.dump ] && [ -e $T/out/nowym_cache-old.dump ]"

run_seeded FAKE_DUMP_FAIL=1 && rc=0 || rc=$?
check "(a) failing pg_dump: exit 1, all old dumps untouched" "[ $rc -eq 1 ] && $old_kept && [ -e $T/out/nowym_users-old.dump.unverified ] && ! ls $T/out | grep -qE -- '-[0-9]{8}-'"

run_seeded FAKE_RESTORE_FAIL=1 && rc=0 || rc=$?
check "(b) failing pg_restore --list: exit 1, renamed to .unverified, old kept" "[ $rc -eq 1 ] && $old_kept && ls $T/out | grep -qE '^nowym_users-[0-9]{8}-[0-9]{6}\.dump\.unverified$' && ls $T/out | grep -qE '^nowym_cache-[0-9]{8}-[0-9]{6}\.dump\.unverified$' && ! ls $T/out | grep -qE '^nowym_(users|cache)-[0-9]{8}-[0-9]{6}\.dump$'"
check "(b) unverified dumps are not uploaded" "[ ! -s $T/curl.stdin ]"

mv "$T/bin/pg_restore" "$T/bin/pg_restore.off"
if command -v pg_restore >/dev/null 2>&1; then echo "skip - (c) real pg_restore on PATH"; else
  run_seeded && rc=0 || rc=$?
  check "(c) no pg_restore: exit 0, warning, new dumps kept" "[ $rc -eq 0 ] && grep -qi 'pg_restore' $T/log && ls $T/out | grep -qE '^nowym_users-[0-9]{8}-[0-9]{6}\.dump$' && ls $T/out | grep -qE '^nowym_cache-[0-9]{8}-[0-9]{6}\.dump$'"
fi
mv "$T/bin/pg_restore.off" "$T/bin/pg_restore"

run_seeded && rc=0 || rc=$?
check "(d) happy path: exit 0, old dumps and old .unverified rotated, new kept" "[ $rc -eq 0 ] && [ ! -e $T/out/nowym_users-old.dump ] && [ ! -e $T/out/nowym_cache-old.dump ] && [ ! -e $T/out/nowym_users-old.dump.unverified ] && [ \$(ls $T/out/*.dump | wc -l) -eq 2 ]"

run_seeded FAKE_CURL_CODE=500 && rc=0 || rc=$?
check "(e) upload failure after good dumps: exit 1, old dumps kept (no rotation)" "[ $rc -eq 1 ] && $old_kept"

echo "failures: $fails"; [ "$fails" -eq 0 ]
