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
 * Запуск .ts напрямую через node: встроенный type stripping (по умолчанию с
 * Node 22.18 / 23.6; tsconfig держит erasableSyntaxOnly), без tsx-лоадера — воркеры
 * рендера карточки наследуют execArgv и тоже не тянут транспилятор.
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

// interpreter = node, под которым выполняется pm2 (см. выше). Если это старый
// node (например, глобальный pm2 под системным Node 20 при nvm-24), бот упал бы
// на `src/main.ts` с невнятным ERR_UNKNOWN_FILE_EXTENSION — падаем сразу и понятно.
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
// порог как engines в package.json: ^22.19 || >=23.6 (в 23.x type stripping
// включён по умолчанию только с 23.6; 23.0–23.5 требуют флаг).
const nodeOk = (nodeMajor === 22 && nodeMinor >= 19) || (nodeMajor === 23 && nodeMinor >= 6) || nodeMajor >= 24;
if (!nodeOk) {
  throw new Error(
    `nowym-ts: pm2 запущен под node ${process.versions.node} (${process.execPath}), ` +
      "а для запуска .ts без транспилятора нужен node >= 22.19 (в ветке 23 — >= 23.6, " +
      "см. engines в package.json). Запусти pm2 под новым node: " +
      "`npm i -g pm2` в нужной версии node, затем `pm2 update`.",
  );
}

module.exports = {
  apps: [
    {
      name: "nowym-ts",
      script: "src/main.ts",
      cwd: __dirname,
      interpreter: process.execPath,
      // --expose-gc: backfill FLAC качает большие буферы; они внешние и не давят
      // на JS-heap → V8 не GC'ит вовремя, RSS пухнет. После альбома зовём global.gc() (infra/gc.ts) между
      // треками, освобождая их принудительно (см. bot/handlers/admin.ts).
      interpreter_args: `--expose-gc --env-file=${path.join(__dirname, ".env")}`,

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
        // glibc: меньше malloc-арен → освобождённые FLAC-буферы реально возвращаются ОС,
        // а не висят в RSS (по умолчанию 8×ядер арен, каждая держит свою фрагментацию)
        MALLOC_ARENA_MAX: "2",
      },
      time: true, // таймстемпы в pm2-логах (у нас свой формат, но pm2 не мешает)
      merge_logs: true,
    },
  ],
};
