<p align="center">
  <img src="assets/banner.png" alt="nowym — yandex music × telegram, gramio edition" width="100%">
</p>

<p align="center">
  <a href="https://nodejs.org"><img alt="node" src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%E2%89%A523.6-339933?logo=node.js&logoColor=white"></a>
  <a href="https://www.typescriptlang.org"><img alt="typescript" src="https://img.shields.io/badge/typescript-7.0-3178C6?logo=typescript&logoColor=white"></a>
  <a href="https://yaebal.mom"><img alt="yaebal" src="https://img.shields.io/badge/framework-yaebal%200.2-2ea44f"></a>
  <img alt="stable" src="https://img.shields.io/badge/status-stable-2ea44f">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="private" src="https://img.shields.io/badge/repo-private-lightgrey">
</p>

Бот для Яндекс Музыки в Telegram. Инлайн-поиск, карточка «сейчас играет»,
выгрузка альбомов, лирика, свой кэш-канал вместо повторных закачек. На
[yaebal](https://yaebal.mom/) 0.2.

## Ништяки

- 🔎 инлайн-поиск треков — `@bot название`, ссылка на трек/альбом, «недавнее»
  (история прослушиваний, с пагинацией и бесконечным скроллом), или вообще
  пусто (тогда отдаёт текущий трек). Опечатки подправляет Yandex suggest;
- 🖼 карточка «сейчас играет» — ambient-рендер на `@napi-rs/canvas`, рендер
  уходит в пул воркеров, чтобы не блокировать event loop;
- ⚡ аудио-эффекты прямо в инлайне — `@bot ncore название` /
  `@bot speed название` / `@bot slow название` (найткор / ускорено /
  замедлено + реверб — так эффект и подписан в названии трека), реальный DSP через ffmpeg, результат кэшируется
  отдельно от оригинала;
- ❤️ лайк/анлайк трека кнопкой под треком;
- 🎚 выбор качества звука — `best` / `economy` / `lossless` (lossless берётся «сырым» потоком,
  без расшифровки; если Яндекс отдал lossy — трек уходит в lossy-тир);
- 📦 выгрузка альбома пачками (`sendMediaGroup`) — с прогрессом, отменой,
  повтором упавших треков, возобновлением после рестарта бота, без OOM даже
  на здоровенных аудиокнигах;
- 💾 свой кэш-канал в Telegram вместо повторных закачек с Яндекса —
  пустышка → реальная заливка, stale-refresh по расписанию;
- 📝 лирика строкой-цитатой — Genius (по фразе, потом по автору/треку),
  фолбэк на Yandex, если не нашлось;
- 🔐 device-flow логин, токены шифруются at-rest (Fernet), ws-наблюдатель
  за плеером владельца (Ynison);
- `/start`, `/help`, `/np`, `/settings`, `/login`, `/logout`, админские
  `/health`, `/broadcast` (с подтверждением и остановкой на лету).

## ⚡ Быстрый старт

Порядок важен: два шага в BotFather — самая частая причина «бот молчит»,
без них бот заведётся и будет выглядеть рабочим, но инлайн не заработает.

1. **Бот в [@BotFather](https://t.me/BotFather):** `/newbot` → токен;
   `/setinline` → любая заглушка подсказки (например `ищу трек…`) —
   **обязательно**, без этого инлайн (`@bot запрос`) не работает вообще;
   `/setinlinefeedback` → выбери бота → `100%` — **обязательно**, иначе
   Telegram присылает `chosen_inline_result` (сигнал «юзер выбрал трек,
   качай») только для доли запросов, и большинство выборов зависают на
   плейсхолдере навсегда.
2. **Канал-кэш:** создай приватный канал, добавь бота админом (права на
   публикацию и удаление сообщений). Узнать numeric id: перешли любое
   сообщение ИЗ канала боту [@userinfobot](https://t.me/userinfobot) —
   формат `-100xxxxxxxxxx`. Свой telegram id (для `ADMIN_USER_ID`) там же.
3. **Клонируй и поставь:**
   ```bash
   git clone <url> nowym && cd nowym
   ./install.sh
   ```
   Спросит токен/id канала/твой id (Enter — пропустить и дозаполнить в
   `.env` вручную), сам сгенерит секреты, при постгресе под рукой —
   накатит роли и пропишет DSN сам. `./install.sh --yes` — то же без
   вопросов (в т.ч. из CI/пайпа): без `--yes` вне терминала шаги, требующие
   подтверждения (например накат postgres-ролей), пропускаются.
4. **Подключение к Telegram** — выбери один способ:
   - **self-hosted Bot API сервер** (рекомендуется — без домена и TLS,
     поднимается локально за пару минут):
     ```bash
     # api_id/api_hash — на my.telegram.org → API development tools (создать приложение)
     docker run -d --name telegram-bot-api --restart always \
       -e TELEGRAM_API_ID=<api_id> -e TELEGRAM_API_HASH=<api_hash> \
       -p 127.0.0.1:8081:8081 aiogram/telegram-bot-api:latest
     ```
     В `.env`: `BOT_API_BASE_URL=http://127.0.0.1:8081/bot` (именно с `/bot`
     на конце — токен и метод бот доклеивает сам).
   - **облачный webhook** — если уже есть домен с TLS-сертификатом (certbot
     и т.п.): заполни `WEBHOOK_HOST`/`WEBHOOK_SSL_CERT`/`WEBHOOK_SSL_KEY` в
     `.env`, `BOT_API_BASE_URL` оставь пустым.
5. **Запуск:** `npm run start` (или `pm2 start ecosystem.config.cjs` —
   конфиг портативный: `cwd`/`interpreter` вычисляются на лету, править его не нужно).

Если что-то не так — бот скажет прямо на старте (например явно укажет,
какая переменная в `.env` не задана), падать молча со временем не должен.

## Как выглядит карточка

Ambient-рендер «сейчас играет» — обложка, размытая в фон, прогресс-бар,
мета-строка (альбом/тип/год/лейбл/номер трека). Два формата: `16:9` под
фото-сообщение, `9:16` под сторис/шортсы.

<p align="center">
  <img src="assets/examples/card-16x9.jpg" alt="карточка 16:9" width="70%">
</p>
<p align="center">
  <img src="assets/examples/card-9x16.jpg" alt="карточка 9:16" width="34%">
</p>

Есть и лирик-режим — вместо прогресс-бара лента строк текста вокруг активной
(Genius → Yandex fallback):

<p align="center">
  <img src="assets/examples/card-lyrics-16x9.jpg" alt="карточка с лирикой 16:9" width="70%">
</p>
<p align="center">
  <img src="assets/examples/card-lyrics-9x16.jpg" alt="карточка с лирикой 9:16" width="34%">
</p>

## Аудио-эффекты

Не настройка, а префикс инлайн-запроса — результат летит через ffmpeg и
кэшируется отдельно от оригинального трека:

```
@bot ncore название трека   — найткор (ускорение + питч вверх)
@bot speed название трека   — ускорено (без питч-шифта)
@bot slow название трека    — замедлено + реверб
```

## Настройки (`/settings`)

Меню `/settings` разбито на два раздела.

**🎧 Трек:** качество звука (`best`/`economy`/`lossless`), подпись и кнопки
(кнопка/текст/всё/ничего), способ отправки (пустышка / текст → медиа).

**🖼 Карточка:** поля (альбом/тип/год/лейбл/номер трека/аватар), прогресс
(`wavy`/`bar`), соотношение сторон (`16:9`/`9:16`), подпись и кнопки под
карточкой и тумблер «карточка + трек» (см. ниже).

### Rich messages (карточка + трек)

Тумблер «карточка + трек» в разделе «карточка», по умолчанию **выкл.** Если включить, карточка
«что играет» (с позицией на момент команды) и сам трек приходят **одним
сообщением**: в инлайне первым результатом, в `/np`, кнопках меню
«что играет» / «карточка» и по ссылке «слушать в лс» (`track_<id>`; для
трека, который сейчас не играет, карточка рисуется на 0:00). Если Bot API
ответил на rich ошибкой, бот присылает карточку и трек по отдельности, как
раньше (в логе одна строка `[rich]`). Если ответа не было вовсе (сеть/таймаут),
исход неизвестен: сообщение могло дойти, поэтому бот ничего не досылает (иначе
будет дубль) и пишет «не удалось подтвердить отправку — проверь чат»; 429
повторяется автоматически. Выключено — поведение прежнее.

Нужен Bot API >= 10.1 на сервере Bot API (в том числе на self-hosted) и свежий
клиент Telegram: старые клиенты могут показать «сообщение не поддерживается».
Новых фоновых задач нет; карточка рисуется только по запросу пользователя.

## Стек

[yaebal](https://yaebal.mom/) 0.2 + `@yaebal/morda` (меню/настройки) +
`@yaebal/runner` (параллельный long-polling) + `ioredis` (стек диалогов) + `@napi-rs/canvas` (рендер
карточки) + `undici`/`node-wreq`.

### Системные зависимости

Кроме Node.js нужны на машине (не npm-пакеты):

- **PostgreSQL** — две базы (users/cache), см. ниже;
- **Redis** — для стека диалогов (`@yaebal/morda`);
- **ffmpeg** — только для аудио-эффектов (`ncore`/`speed`/`slow`, см. ниже);
  без него всё остальное работает, просто эта фича упадёт с понятной ошибкой;
- **Docker** — опционально. Либо только для self-hosted Bot API сервера
  (см. «Быстрый старт» — без домена/TLS через него проще всего), либо для
  всей установки целиком через `docker-compose.yml` (см. «Через Docker»
  ниже) — тогда Postgres/Redis тоже не нужно ставить на хост руками.

Debian/Ubuntu:

```bash
sudo apt install postgresql redis-server ffmpeg
```

## Как поставить

`./install.sh` из «Быстрого старта» выше делает всё это за один проход:
проверит node, поставит зависимости (`npm ci` по `package-lock.json`),
подготовит `.env` (секреты сгенерит сам; спросит токен/id канала/твой id и
впишет их же), при доступном постгресе — накатит роли и пропишет
`POSTGRES_*_DSN` сам (пароли сгенерены, руками синхронизировать не с чем),
проверит redis/ffmpeg и pm2 (`ecosystem.config.cjs` портативен, его скрипт не
правит), прогонит typecheck как smoke-тест. Если накат ролей упал, лог psql
лежит во временном файле (`mktemp`), путь печатается в выводе.

Руками — то же самое по шагам:

```bash
npm ci
cp .env.example .env
```

### Через Docker

Альтернатива `install.sh` — `docker-compose.yml` поднимает бота вместе с
Postgres и Redis, без ручной установки чего-либо на хост-машину кроме
Docker:

```bash
cp .env.example .env
# заполни .env: TELEGRAM_BOT_TOKEN/TELEGRAM_CHANNEL_ID/ADMIN_USER_ID,
# POSTGRES_USERS_DSN/POSTGRES_CACHE_DSN (host — `postgres`, не 127.0.0.1),
# NOWYM_USERS_PASSWORD/NOWYM_CACHE_PASSWORD (те же пароли, что в DSN),
# POSTGRES_SUPERUSER_PASSWORD (обязателен — без него `docker compose` не стартует;
# пароль суперпользователя postgres, дефолта нет),
# REDIS_HOST=redis, WEBHOOK_SECRET/NOW_PLAYING_TOKEN
# (сгенерить: node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')
# TOKEN_ENCRYPTION_KEY — Fernet-ключ, base64url С паддингом (44 символа, как делает install.sh):
# node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64").replace(/\+/g,"-").replace(/\//g,"_"))'
docker compose up -d --build
```

Порт `8443` публикуется только на loopback (`127.0.0.1`); для прямого
публичного доступа задай `NOWYM_BIND_HOST=0.0.0.0`. У сервисов стоят
лимиты памяти (`mem_limit`), бот в контейнере работает не от root. Пароль
Redis (`REDIS_PASSWORD`) в compose опционален, но бот его пока не читает — с
непустым значением бот к Redis не подключится, оставь пустым.

Postgres-роли (`nowym_users_app`/`nowym_cache_app`) создаются автоматически
при первом старте контейнера (`docs/sql/docker-init.sh`), схему таблиц
внутри баз бот накатывает сам, как и везде. Подключение к Telegram — тот же
выбор `BOT_API_BASE_URL`/`WEBHOOK_HOST` из «Быстрого старта» выше (self-hosted
Bot API сервер удобнее поднять отдельным контейнером рядом, см. пример там).

### Переменные `.env`

Обязательные (без них бот не стартует — упадёт с явной ошибкой, какой
переменной не хватает):

| Переменная | Назначение |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен бота от @BotFather |
| `TELEGRAM_CHANNEL_ID` | id служебного канала-кэша (бот — админ канала) |
| `TOKEN_ENCRYPTION_KEY` | ключ шифрования токенов в БД (`install.sh` генерит сам) |
| `POSTGRES_USERS_DSN` | DSN базы пользователей |
| `POSTGRES_CACHE_DSN` | DSN базы кэша |
| `BOT_API_BASE_URL` **или** `WEBHOOK_HOST` | один из двух обязателен — способ получать апдейты от Telegram, см. «Быстрый старт» |

Функционально обязательна, хоть и не проверяется на старте:
`ADMIN_USER_ID` — без него `/health`/`/broadcast` недоступны никому
(гейт fail-closed) и алерты об ошибках в личку админу не шлются.

`WEBHOOK_SECRET` в webhook-режиме обязателен по сути: пустой — все POST на
webhook отвечают 401 (бот при этом стартует). Числовые переменные
разбираются строго: мусор (`abc`, `1e3`, значение с инлайн-комментарием
`60 # сек`) роняет старт с ошибкой, называющей переменную.

Опционально: `METRICS_TOKEN` (если задан — `GET /metrics` и детали
`/health` требуют `Authorization: Bearer ...`; пусто — открыто, как раньше),
`GENIUS_TOKEN` (лирика точнее — ключ на genius.com/api-clients),
`OWNER_ID` (кто в Ynison-наблюдателе, по умолчанию = `ADMIN_USER_ID`),
`POLLING_STALL_SEC` (long-polling: секунд без завершённого `getUpdates`, после
которых сторож обрывает висящий запрос, а при повторе завершает процесс для
рестарта pm2; дефолт 90, `0` — выкл.),
`STALE_REFRESH_LIMIT` (сколько протухших пустышек ежечасно перекачивать в
кэш-канал; дефолт 50, `0` — выкл.),
`WEBHOOK_PATH`/`WEBHOOK_SECRET`/`WEBHOOK_SSL_CERT`/`WEBHOOK_SSL_KEY`
(детали облачного webhook-режима), `NOW_PLAYING_TOKEN` (без него `GET
/now-playing` всегда 401), `ICON_SET_NAME` (Telegram custom-emoji пак для
иконок кнопок — дефолт `tgiosicons` публичный, работает без настройки;
свой пак — через @Stickers), лимиты и размеры кэшей — дефолты и полный
список в `src/settings.ts`.

### База данных

Две изолированные Postgres-базы (users/cache). `install.sh` накатывает
роли автоматически (пароли генерит сам, тут же прописывает DSN в `.env`).
Руками — один раз:

```bash
sudo -u postgres psql -f docs/sql/init.sql   # свои пароли вместо CHANGE_ME_*
```

и те же пароли — в `POSTGRES_*_DSN` в `.env`. Схему таблиц внутри баз бот
создаёт сам при первом старте, руками накатывать не нужно.

### Redis

Нужен для стека диалогов (`@yaebal/morda`). Дефолт — `localhost:6379`, без
пароля. `sudo apt install redis-server && sudo systemctl enable --now redis-server`.

## Запуск

```bash
npm run start       # node src/main.ts — webhook (облако) или long-polling (self-hosted API)
npm run dev         # то же самое, но node --watch — авто-рестарт на изменениях
npm run typecheck   # tsc --noEmit
npm run lint         # biome check . (npm run lint:fix — почить автофиксом)
npm test            # node --test (нативный type stripping), ~440 тестов, секунд 45
```

Режим выбирается сам: задан `BOT_API_BASE_URL` → self-hosted Bot API сервер +
long-polling; пусто → облако + webhook. В webhook-режиме поднимается один
http(s)-сокет с роутами: `WEBHOOK_PATH` (апдейты Telegram, опционально
проверяется `X-Telegram-Bot-Api-Secret-Token`), `GET /now-playing` (JSON о
текущем треке владельца + недавние (`recent`, до 20 последних, из живых
трекчейнджей вотчера, без похода в Yandex API), `Authorization: Bearer
NOW_PLAYING_TOKEN`), `GET /health` и `GET /metrics` (Prometheus text —
статус пулов Postgres, hit/miss in-memory кэшей, статус Ynison-вотчера,
счётчики ошибок/rate-limit-реджектов; без авторизации, пока не задан
`METRICS_TOKEN`).
TLS — если заданы `WEBHOOK_SSL_CERT`/`WEBHOOK_SSL_KEY`.

### Прод (pm2)

В репе есть готовый `ecosystem.config.cjs` (единственный fork-инстанс,
autorestart, `--expose-gc`). Полностью портативный — `cwd`/`interpreter`
вычисляются на лету (`__dirname`/`process.execPath`), патчить или
адаптировать под сервер не нужно, работает сразу после клонирования куда
угодно.

```bash
pm2 start ecosystem.config.cjs
pm2 save          # чтобы пережило ребут (после pm2 startup)
pm2 logs nowym-ts
```

**Обновление с ≤1.8 (tsx удалён).** pm2 помнит старые `interpreter_args`
(`--import tsx`) у существующего процесса, и после `npm ci` бот уйдёт в
crash-loop с `ERR_MODULE_NOT_FOUND 'tsx'`. Один раз пересоздай процесс:

```bash
pm2 delete nowym-ts && pm2 start ecosystem.config.cjs && pm2 save
```

### Бэкапы

`nowym_users` хранит зашифрованные OAuth-токены — потеря базы означает,
что все переавторизуются заново. `scripts/backup.sh` дампит обе базы
(`pg_dump -Fc`), проверяет каждый дамп через `pg_restore --list` и шлёт оба
файла `ADMIN_USER_ID` в личку (`TELEGRAM_BOT_TOKEN`/`BOT_API_BASE_URL` из
`.env`; `.env` скрипт не `source`-ит, токен в argv не светится; на
self-hosted Bot API сервере лимит на файл 2ГБ, не 50МБ как в облаке).
Параллельный запуск блокируется (`flock`), файлы создаются с `umask 077`.

Ротация (дампы, `*.dump.unverified` и `env-*` старше
`NOWYM_BACKUP_KEEP_DAYS`, по умолчанию 14 дней) выполняется **только после
полностью успешного запуска** — иначе при постоянных сбоях старые хорошие
бэкапы пропали бы. Дамп, не прошедший проверку, переименовывается в
`*.dump.unverified`. Код возврата: `0` — дампы сняты и отправлены (или отправка
не настроена); `1` — дамп не снялся/не прошёл проверку, отправка в Telegram не
удалась или уже идёт другой запуск (локальные дампы остаются). Переменные:
`NOWYM_BACKUP_DIR` (по умолчанию `/var/backups/nowym`),
`NOWYM_BACKUP_KEEP_DAYS`, `NOWYM_PG_MODE=docker` (дампить через
`docker compose exec -T postgres`), `NOWYM_BACKUP_ENV=1` (дополнительно
положить локальную копию `.env` с `TOKEN_ENCRYPTION_KEY`, права 600, в
Telegram не уходит; по умолчанию выключено — задаётся в окружении cron-задачи,
не в `.env`).

```bash
./scripts/backup.sh                                    # разово, в /var/backups/nowym
crontab -e                                              # раз в сутки:
# 59 20 * * * /path/to/nowym/scripts/backup.sh >> /var/log/nowym-backup.log 2>&1
```

**Восстановление** — `scripts/restore.sh <stamp> [--db nowym_users|nowym_cache] [--yes]`.
`<stamp>` — часть имени дампа между `nowym_users-`/`nowym_cache-` и `.dump`
(например `20261126-205900`). Без `--yes` скрипт только проверяет, что дампы
читаются, и печатает план. С `--yes` останавливает бота (pm2 или docker
compose, определяется сам), делает `pg_restore --clean --if-exists`
(**затирает** текущие данные) и бота обратно **не** запускает — запусти руками
после проверки. Переменные: `NOWYM_BACKUP_DIR`, `NOWYM_PG_MODE=docker`,
`NOWYM_PM2_NAME` (`nowym-ts`), `NOWYM_PM2_USER`.

**Откат кода** — `sudo scripts/rollback.sh <STAMP>`. Нужна копия дерева,
снятая перед деплоем: `$NOWYM_APP_DIR.prev-<STAMP>` (pm2; по умолчанию
`/home/rage/nowym.prev-<STAMP>`) или образ `nowym-bot:prev-<STAMP>` (docker).
Схема БД аддитивная, старый код работает на новой схеме; данные БД скрипт не
трогает (для них `restore.sh`). Переменные: `NOWYM_APP_DIR`,
`NOWYM_PM2_NAME`, `NOWYM_PM2_USER`, `NOWYM_HEALTH_URL` (по умолчанию
`http://127.0.0.1:8443/health`), `NOWYM_HEALTH_CURL_OPTS`.

## Структура

| Путь | Назначение |
|---|---|
| `src/bot/` | хендлеры, диалоги-меню (`@yaebal/morda`), сборка бота (`app.ts`), сборка карточки, DI-контейнер |
| `src/bot/iconSet.ts` | резолвер премиум-эмодзи (`icon_custom_emoji_id`) под кнопки |
| `src/bot/texts.ts` | все пользовательские тексты в едином стиле (правила в шапке файла, проверяет `test/texts.test.ts`) |
| `src/services/` | рендер карточки (+ пул воркеров `cardRenderPool.ts`), поиск, кэш, альбомы, рассылка. `lyricsVideo.ts` — закомментированная заготовка, не живой код |
| `src/yandex/` | клиент Yandex Music API, метаданные, лирика, Ynison |
| `src/infra/` | http-клиент, шифрование, логирование, rate-limit, ретраи 429/5xx (`floodRetry.ts`), алертер об ошибках админу (`adminAlerter.ts`) |
| `src/storage/` | пулы Postgres, схемы users/cache/settings |
| `src/tagging/` | тегирование аудио (TagLib/ffmpeg) |
| `test/` | `node:test`, 402 штуки; `npm test` не читает реальный `.env` (`NODE_ENV=test`) |
| `install.sh` | установка в одну команду (см. выше) |
| `docs/sql/init.sql` | создание Postgres-ролей и баз (bare-metal) |
| `docs/sql/docker-init.sh` | то же самое, но для первого старта postgres-контейнера |
| `Dockerfile`, `docker-compose.yml` | альтернатива `install.sh` — бот+Postgres+Redis в контейнерах |
| `scripts/backup.sh` | pg_dump обеих баз + ротация, крон-скрипт |
| `scripts/restore.sh`, `scripts/rollback.sh` | восстановление БД из дампа / откат кода на предыдущую копию (см. «Бэкапы») |
| `biome.json` | конфиг линтера/форматтера (`npm run lint`) |

## Если что-то сломалось

1. **Бот запускается, но `@bot запрос` ничего не отдаёт** — почти всегда
   забытый `/setinline` в BotFather. Проверить: `/setinline` без аргумента
   в диалоге с BotFather покажет текущий статус.
2. **Инлайн-выдача показывается, но выбор трека зависает на плейсхолдере
   («качаю…») навсегда** — забытый `/setinlinefeedback` → `100%` в
   BotFather. Без него Telegram шлёт `chosen_inline_result` не на каждый
   выбор, а бот именно по этому сигналу качает и подменяет плейсхолдер на
   реальное аудио.
3. **Бот не стартует вовсе** — `.env` неполный, ошибка при старте называет
   переменную явно (`X не задан в .env`). Если ругается на «ни
   BOT_API_BASE_URL, ни WEBHOOK_HOST» — см. «Быстрый старт», шаг 4, нужен
   ровно один из двух способов получать апдейты.
4. `npm run typecheck` и `npm test` — если не про конфиг, а про сам код.
5. `pm2 logs nowym-ts` и `GET /health` — если это прод. Свежий рестарт
   подхватывает `.env` и код с диска, а не то, что было закешировано
   node-процессом в памяти.

## Контрибьютинг

PR приветствуются — см. [CONTRIBUTING.md](CONTRIBUTING.md): как гонять
typecheck/lint/тесты локально и чего ждать от PR.

## Лицензия

[MIT](LICENSE) — используй как хочешь, в коммерции и не только, но
сохраняй указание оригинального авторства.
