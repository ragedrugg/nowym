#!/usr/bin/env bash
# установка nowym-ts (gramio edition) в одну команду.
#
# делает: проверяет node, ставит зависимости, готовит .env (секреты и
# постгресовые пароли генерит сам, при подтверждении сразу накатывает
# postgres-роли), проверяет redis/ffmpeg, патчит ecosystem.config.cjs под
# текущую машину, гоняет typecheck как smoke-тест.
#
#   ./install.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

c_bold=$'\033[1m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_cyan=$'\033[36m'; c_off=$'\033[0m'
ok()   { echo "${c_green}✓${c_off} $*"; }
warn() { echo "${c_yellow}!${c_off} $*"; }
err()  { echo "${c_red}✗${c_off} $*" >&2; }
step() { echo; echo "${c_bold}${c_cyan}▸ $*${c_off}"; }

# интерактивные подсказки — только если реально в терминале (не CI/пайп)
INTERACTIVE=0
[ -t 0 ] && [ -t 1 ] && INTERACTIVE=1

ask() {
  # ask "вопрос" "дефолт" -> stdout: введённое или дефолт
  local prompt="$1" def="${2:-}"
  if [ "$INTERACTIVE" -ne 1 ]; then printf '%s' "$def"; return; fi
  local reply
  read -r -p "  ${prompt}$([ -n "$def" ] && echo " [$def]"): " reply || true
  printf '%s' "${reply:-$def}"
}

confirm() {
  # confirm "вопрос" -> 0 (да) / 1 (нет); дефолт "да" вне терминала
  local prompt="$1" reply
  if [ "$INTERACTIVE" -ne 1 ]; then return 0; fi
  read -r -p "  ${prompt} [Y/n]: " reply || true
  [ -z "$reply" ] || [[ "$reply" =~ ^[Yy] ]]
}

gen_secret() { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))'; }
gen_pw()     { node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("base64url"))'; }

step "нода"
if ! command -v node >/dev/null 2>&1; then
  err "node не найден. нужен Node.js >= 22 (nvm install 22 / apt / брю — на твой вкус)."
  exit 1
fi
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  err "стоит node $(node -v), нужен >= 22. апгрейдь и запускай заново."
  exit 1
fi
ok "node $(node -v)"

step "зависимости"
npm install
ok "npm install готов"

step ".env"
ENV_FILE="$SCRIPT_DIR/.env"
ENV_EXAMPLE="$SCRIPT_DIR/.env.example"
ENV_IS_NEW=0
if [ -f "$ENV_FILE" ]; then
  ok ".env уже есть, не трогаю существующие значения"
else
  if [ ! -f "$ENV_EXAMPLE" ]; then
    err "не нашёл .env.example рядом — создавай .env руками."
    exit 1
  fi
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  ENV_IS_NEW=1
  ok "скопировал .env.example → .env"
fi

set_env() {
  # set_env KEY VALUE — только если сейчас KEY= пусто (не трогаем то, что уже заполнено)
  local key="$1" val="$2"
  if grep -q "^${key}=$" "$ENV_FILE" 2>/dev/null; then
    local esc; esc="$(printf '%s' "$val" | sed -e 's/[&|\\]/\\&/g')"
    sed -i "s|^${key}=$|${key}=${esc}|" "$ENV_FILE"
  fi
}

if [ "$ENV_IS_NEW" -eq 1 ]; then
  set_env "TOKEN_ENCRYPTION_KEY" "$(gen_secret)"
  set_env "WEBHOOK_SECRET" "$(gen_secret)"
  set_env "NOW_PLAYING_TOKEN" "$(gen_secret)"
  ok "сгенерил TOKEN_ENCRYPTION_KEY / WEBHOOK_SECRET / NOW_PLAYING_TOKEN"

  echo
  echo "  дальше — то, что руками достать больше негде. Enter — оставить пустым и"
  echo "  дозаполнить в .env самому позже."
  BOT_TOKEN="$(ask "токен бота (от @BotFather, команда /newbot)")"
  [ -n "$BOT_TOKEN" ] && set_env "TELEGRAM_BOT_TOKEN" "$BOT_TOKEN"
  CHANNEL_ID="$(ask "id канала-кэша (создай приватный канал, добавь бота админом, перешли из канала любое сообщение боту @userinfobot)")"
  [ -n "$CHANNEL_ID" ] && set_env "TELEGRAM_CHANNEL_ID" "$CHANNEL_ID"
  ADMIN_ID="$(ask "твой telegram id (напиши @userinfobot)")"
  [ -n "$ADMIN_ID" ] && set_env "ADMIN_USER_ID" "$ADMIN_ID"
fi

step "postgres"
PG_READY=0
if command -v pg_isready >/dev/null 2>&1 && pg_isready -q 2>/dev/null; then
  PG_READY=1
  ok "postgres отвечает на localhost"
elif command -v psql >/dev/null 2>&1; then
  warn "psql есть, но сервер не отвечает (не запущен?) — sudo systemctl enable --now postgresql"
else
  warn "postgres не найден — sudo apt install postgresql && sudo systemctl enable --now postgresql"
fi

DB_READY_IN_ENV=0
if [ "$PG_READY" -eq 1 ] && [ "$ENV_IS_NEW" -eq 1 ]; then
  echo "  накатить роли/базы (nowym_users, nowym_cache) прямо сейчас? Пароли сгенерю"
  echo "  сам и сразу пропишу в .env — синхронизировать руками ничего не придётся."
  if confirm "накатить postgres-роли автоматически"; then
    PW_USERS="$(gen_pw)"; PW_CACHE="$(gen_pw)"
    # через stdin, не временный файл: `sudo -u postgres` не смог бы прочитать
    # файл, созданный mktemp от текущего юзера (права 600, чужой владелец) —
    # без файла эта проблема просто не существует.
    SQL_FILLED="$(sed \
      -e "s/CHANGE_ME_USERS/${PW_USERS}/" \
      -e "s/CHANGE_ME_CACHE/${PW_CACHE}/" \
      docs/sql/init.sql)"
    if sudo -u postgres psql -v ON_ERROR_STOP=1 >/tmp/nowym-install-psql.log 2>&1 <<< "$SQL_FILLED"; then
      set_env "POSTGRES_USERS_DSN" "postgresql://nowym_users_app:${PW_USERS}@127.0.0.1:5432/nowym_users"
      set_env "POSTGRES_CACHE_DSN" "postgresql://nowym_cache_app:${PW_CACHE}@127.0.0.1:5432/nowym_cache"
      DB_READY_IN_ENV=1
      ok "роли и базы созданы, DSN прописаны в .env"
    else
      err "psql упал — лог в /tmp/nowym-install-psql.log (частая причина: роли уже существуют — тогда"
      err "просто пропиши POSTGRES_*_DSN в .env вручную с уже имеющимися паролями)."
    fi
  fi
fi
if [ "$DB_READY_IN_ENV" -eq 0 ]; then
  echo "  накатить вручную (пароли из docs/sql/init.sql подставь свои, те же — в POSTGRES_*_DSN):"
  echo "    sudo -u postgres psql -f docs/sql/init.sql"
  echo "  схему таблиц внутри баз бот создаёт сам при первом старте."
fi

step "redis"
if command -v redis-cli >/dev/null 2>&1 && redis-cli -h 127.0.0.1 ping >/dev/null 2>&1; then
  ok "redis отвечает на localhost:6379"
else
  warn "redis не отвечает — нужен для меню/настроек (@gramio/dialogs)."
  warn "sudo apt install redis-server && sudo systemctl enable --now redis-server"
fi

step "ffmpeg"
if command -v ffmpeg >/dev/null 2>&1; then
  ok "ffmpeg найден"
else
  warn "ffmpeg не найден — нужен только для аудио-эффектов (ncore/speed/slow),"
  warn "остальной бот заработает и без него. apt install ffmpeg / brew install ffmpeg."
fi

step "подключение к Telegram"
echo "  два варианта, оба описаны в README:"
echo "  • self-hosted Bot API сервер (BOT_API_BASE_URL) — long-polling, без домена и TLS,"
echo "    поднимается локально докером за пару минут. Рекомендуется для быстрого старта."
echo "  • облачный webhook (WEBHOOK_HOST) — нужен публичный домен с TLS-сертификатом."
if command -v docker >/dev/null 2>&1; then
  ok "docker найден — self-hosted Bot API сервер поднимается прямо сейчас, см. README"
else
  warn "docker не найден — либо ставь (get.docker.com), либо иди путём webhook"
fi

step "pm2"
if command -v pm2 >/dev/null 2>&1; then
  ok "pm2 найден — ecosystem.config.cjs портативен сам по себе (cwd/interpreter"
  ok "вычисляются на лету), патчить его не нужно: pm2 start ecosystem.config.cjs"
else
  warn "pm2 не найден (npm i -g pm2) — без него запускай просто npm run start"
fi

step "typecheck (smoke-тест, что всё встало ровно)"
if npx tsc --noEmit; then
  ok "typecheck чистый"
else
  err "typecheck упал — читай выше, что не так, и почини перед стартом."
  exit 1
fi

echo
echo "${c_bold}${c_green}готово.${c_off} чек-лист перед первым стартом:"
echo "  1. в @BotFather на бота: /setinline (обязательно — без этого инлайн не работает)"
echo "     и /setinlinefeedback → 100% (обязательно — иначе выбор трека не долетает до бота)"
echo "  2. добить .env, если что-то осталось пустым (см. предупреждения выше)"
echo "  3. решить, как бот будет получать апдейты — BOT_API_BASE_URL или WEBHOOK_HOST (см. README)"
echo "  4. npm run start   — или pm2 start ecosystem.config.cjs для прода"
echo "  5. бэкапы БД (не обязательно, но советую) — раз в crontab -e:"
echo "     0 4 * * * $SCRIPT_DIR/scripts/backup.sh >> /var/log/nowym-backup.log 2>&1"
