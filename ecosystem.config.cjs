/**
 * pm2-конфиг автозапуска nowym-ts.
 *
 * Полностью портативный — ничего не хардкожено под конкретную машину,
 * ничего не нужно патчить после клонирования:
 *   - cwd: __dirname — директория самого этого файла, какой бы путь ни
 *     был у клона.
 *   - interpreter: process.execPath — абсолютный путь ИМЕННО того node,
 *     под которым сейчас выполняется pm2-демон (парсящий этот файл через
 *     require()). Абсолютный путь принципиален: при boot-resurrect у
 *     pm2-демона (поднятого systemd-юнитом от `pm2 startup`) в PATH нет
 *     nvm, и голый "node" не резолвился бы — но именно ту же проблему уже
 *     решил `pm2 startup`, сгенерировав юнит с абсолютным путём к node
 *     для самого pm2. process.execPath просто переиспользует то же
 *     решение, а не хардкодит версию — апгрейднул node через nvm и заново
 *     прогнал `pm2 startup`/перезапустил демон — тут ничего править не
 *     нужно.
 *   - --env-file тоже через __dirname, не абсолютным путём.
 *
 * Запуск .ts напрямую через node + tsx-лоадер (как в старом ExecStart).
 * pm2 по умолчанию шлёт SIGINT на stop — main.ts ловит его для graceful
 * shutdown (delete_webhook + закрытие пулов).
 *
 * Режим — единственный fork-инстанс (НЕ cluster): приложение stateful —
 * webhook-http-сервер на одном порту, in-memory кэши (треки/аватары/владельцы
 * инлайнов), ws-watcher Ynison. Кластеризация разъехала бы это состояние и
 * подралась бы за порт.
 *
 * Логи намеренно НЕ переопределяем (пишем в дефолтный ~/.pm2/logs) — их ротейтит
 * модуль pm2-logrotate; кастомный путь вывалился бы из ротации.
 */
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "nowym-ts",
      script: "src/main.ts",
      cwd: __dirname,
      interpreter: process.execPath,
      // --expose-gc: backfill FLAC качает большие буферы; они внешние и не давят
      // на JS-heap → V8 не GC'ит вовремя, RSS пухнет. Цикл зовёт global.gc() между
      // треками, освобождая их принудительно (см. bot/handlers/admin.ts).
      interpreter_args: `--import tsx --expose-gc --env-file=${path.join(__dirname, ".env")}`,

      // ── жизненный цикл ────────────────────────────────────────────────
      autorestart: true,
      // экспоненциальный backoff вместо фиксированной паузы: при флапающем
      // апстриме/БД не молотим рестартами (3с → 6с → 12с… до 15с потолка pm2).
      exp_backoff_restart_delay: 3000,
      // защита от crash-loop: если процесс не прожил min_uptime и так
      // max_restarts раз подряд — pm2 помечает errored и перестаёт поднимать
      // (иначе битый деплой крутился бы вечно, скрывая проблему).
      min_uptime: "60s",
      max_restarts: 15,
      kill_timeout: 15000, // = TimeoutStopSec systemd: дать дожать graceful shutdown
      max_memory_restart: "2500M", // запас под один тяжёлый трек (≤1.2гб, двойной буфер) под heavyLock
      watch: false,

      // ── окружение / логи ──────────────────────────────────────────────
      env: {
        NODE_ENV: "production",
      },
      time: true, // таймстемпы в pm2-логах (у нас свой формат, но pm2 не мешает)
      merge_logs: true,
    },
  ],
};
