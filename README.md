<p align="center">
  <img src="assets/banner.png" alt="nowspot — spotify × telegram, форк nowym" width="100%">
</p>

<p align="center">
  <a href="https://nodejs.org"><img alt="node" src="https://img.shields.io/badge/node-%E2%89%A5%2022-339933?logo=node.js&logoColor=white"></a>
  <a href="https://www.typescriptlang.org"><img alt="typescript" src="https://img.shields.io/badge/typescript-5.7-3178C6?logo=typescript&logoColor=white"></a>
  <a href="https://gramio.dev"><img alt="gramio" src="https://img.shields.io/badge/framework-GramIO%200.12-2ea44f"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

Форк [nowym](https://github.com/pmdw/nowym) под Spotify. Всё, что можно, —
через официальный Spotify Web API (метаданные, поиск, лайки, «сейчас
играет»), аудио — через `yt-dlp` (YouTube + SoundCloud фолбэком, матчинг по
ISRC + длительности). Карточка «сейчас играет», инлайн-поиск, кэш-канал,
выгрузка альбомов, аудио-эффекты — как в оригинале.

## Что работает / что нет

**Работает:**
- 🔎 инлайн-поиск (`@bot название`, ссылка на трек/альбом/плейлист Spotify,
  «недавнее» из `/me/player/recently-played`, пусто → текущий трек);
- 🖼 карточка «сейчас играет» — рендер тот же, ambient-cover в фон, прогресс,
  16:9 / 9:16 (см. `/settings`);
- ⚡ аудио-эффекты `ncore` / `speed` / `slow` (nightcore / ускорение /
  замедление+реверб) — через ffmpeg поверх скачанного трека;
- ❤️ лайк/анлайк через `PUT/DELETE /me/tracks`;
- 📦 выгрузка альбомов/плейлистов пачками (10 треков в `sendMediaGroup`),
  с прогрессом, отменой, повтором упавших, возобновлением после рестарта;
- 💾 кэш-канал в Telegram: один раз скачал → лежит там → все следующие
  вызовы того же трека берут `file_id` без похода в yt-dlp;
- 📝 лирика через Genius (Spotify API текста не отдаёт);
- 🔐 OAuth Authorization Code + PKCE, токены шифруются at-rest (Fernet).

**Не работает по ограничениям Spotify:**
- lossless / выбор кодека выше того, что даёт yt-dlp (обычно opus 128–160
  kbps c YouTube Music / Topic-каналов);
- «зачесть прослушивание» в статистику Spotify через бота (нет API);
- любой контент только в Spotify (эксклюзивы, подкасты без YouTube-версии).

## ⚡ Быстрый старт

1. **Бот в [@BotFather](https://t.me/BotFather):** `/newbot` → токен;
   `/setinline` → любая заглушка подсказки (например `ищу трек...`) —
   **обязательно**; `/setinlinefeedback` → выбери бота → `100%` —
   **обязательно**, иначе Telegram шлёт `chosen_inline_result` только для
   доли запросов и большинство выборов зависают на плейсхолдере.
2. **Spotify-приложение:** [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) →
   Create app. Redirect URI:
   - **webhook-режим** (есть домен, `WEBHOOK_HOST`): `https://<домен>/spotify/callback`
   - **long-polling / без домена**: `http://127.0.0.1:8888/callback` — юзер
     после авторизации скопирует `code=...` из адресной строки и пришлёт
     боту. Локальный сервер поднимать не нужно, важно взять код.
   Из dashboard'а скопируй **Client ID** в `SPOTIFY_CLIENT_ID` (secret не
   нужен — используем PKCE).
3. **Канал-кэш:** создай приватный канал, добавь бота админом (публикация +
   удаление сообщений). Numeric id узнать: перешли любое сообщение ИЗ канала
   боту [@userinfobot](https://t.me/userinfobot) — формат `-100xxxxxxxxxx`.
   Свой Telegram id (для `ADMIN_USER_ID`) там же.
4. **Клонируй и поставь:**
   ```bash
   git clone <url> nowspot && cd nowspot
   ./install.sh
   ```
   Спросит токен/id канала/твой id/Spotify Client ID (Enter — пропустить и
   дозаполнить в `.env` вручную), сам сгенерит секреты, при постгресе под
   рукой — накатит роли и пропишет DSN сам.
5. **Подключение к Telegram** — выбери один способ:
   - **self-hosted Bot API сервер** (рекомендуется — без домена и TLS):
     ```bash
     # api_id/api_hash — на my.telegram.org → API development tools
     docker run -d --name telegram-bot-api --restart always \
       -e TELEGRAM_API_ID=<api_id> -e TELEGRAM_API_HASH=<api_hash> \
       -p 127.0.0.1:8081:8081 aiogram/telegram-bot-api:latest
     ```
     В `.env`: `BOT_API_BASE_URL=http://127.0.0.1:8081/bot`.
   - **облачный webhook** — если уже есть домен с TLS (certbot и т.п.):
     заполни `WEBHOOK_HOST`/`WEBHOOK_SSL_CERT`/`WEBHOOK_SSL_KEY` в `.env`,
     `BOT_API_BASE_URL` оставь пустым.
6. **Запуск:** `npm run start` (или `pm2 start ecosystem.config.cjs`).

## Аудио-эффекты

```
@bot ncore название трека   — nightcore (ускорение + питч вверх)
@bot speed название трека   — ускорение без питч-шифта
@bot slow название трека    — замедление + реверб
```

## Настройки (`/settings`)

Качество звука (`best` / `economy` — что берёт yt-dlp), формат ответа
(кнопка/текст/всё/ничего — отдельно для трека и карточки), какие поля
показывать на карточке, стиль прогресс-бара (`wavy`/`bar`), соотношение
сторон (`16:9`/`9:16`).

## Стек

- [GramIO](https://gramio.dev/) 0.12 + `@gramio/dialogs` + `@gramio/format`
  + `@gramio/storage-redis` + `@napi-rs/canvas` (рендер карточки)
  + `undici` (HTTP пул) + `ws` (не используется, но осталось от Ynison
  и не мешает — уберётся в следующем чистом релизе);
- собственный клиент Spotify Web API (`src/music/`);
- `yt-dlp` как внешний процесс для аудио (`src/audio/ytdlp.ts`);
- Genius для лирики.

### Системные зависимости

- **Node.js ≥ 22**
- **PostgreSQL** — две БД (users/cache), схема создаётся автоматически;
- **Redis** — для `@gramio/dialogs`;
- **yt-dlp** — обязательно, иначе скачивание не работает вообще
  (`sudo apt install yt-dlp` или через pip);
- **ffmpeg** — для тегирования и аудио-эффектов;
- **Docker** — опционально (для self-hosted Bot API сервера или через
  `docker-compose.yml`).

Debian/Ubuntu:
```bash
sudo apt install postgresql redis-server ffmpeg
sudo apt install yt-dlp    # или: pipx install yt-dlp
```

### Переменные `.env`

Обязательные (без них бот не стартует):

| Переменная | Назначение |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен бота от @BotFather |
| `TELEGRAM_CHANNEL_ID` | id служебного канала-кэша (бот — админ канала) |
| `SPOTIFY_CLIENT_ID` | Client ID приложения Spotify (dashboard) |
| `TOKEN_ENCRYPTION_KEY` | ключ шифрования токенов в БД (`install.sh` генерит) |
| `POSTGRES_USERS_DSN` | DSN базы пользователей |
| `POSTGRES_CACHE_DSN` | DSN базы кэша |
| `BOT_API_BASE_URL` **или** `WEBHOOK_HOST` | один из двух обязателен |

Полный список — в `.env.example` и `src/settings.ts`.

## Запуск

```bash
npm run start       # tsx src/main.ts
npm run dev         # tsx watch — авто-рестарт на изменениях
npm run typecheck   # tsc --noEmit
npm run lint        # biome check .
npm test            # node --import tsx --test
```

Режим выбирается сам: `BOT_API_BASE_URL` задан → self-hosted Bot API +
long-polling; пусто → облако + webhook. В webhook-режиме поднимается один
http(s)-сокет с роутами: `WEBHOOK_PATH` (апдейты Telegram), `/spotify/callback`
(OAuth), `GET /now-playing` + `GET /now-playing/stream` (Bearer
`NOW_PLAYING_TOKEN`), `/health`, `/metrics`. TLS — если заданы
`WEBHOOK_SSL_CERT`/`WEBHOOK_SSL_KEY`.

## Про юридическое

`yt-dlp` качает с YouTube/SoundCloud — это нарушает их ToS и Spotify ToS.
Для приватного бота «для себя и друзей» на своём сервере этим годами
пользуются тысячи людей. Публиковать в открытый доступ или продавать
подписки — путь к DMCA. Оригинальный nowym в этом смысле в такой же зоне.

## Лицензия

[MIT](LICENSE). Форк nowym: сохраняй указание оригинального авторства
(`pmdw/nowym`).
