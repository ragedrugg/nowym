/**
 * Лёгкий логгер с уровнями и human/json-форматом, без зависимостей.
 * Уровень/формат читаются прямо из env, а не через settings — чтобы не тянуть
 * валидацию обязательных переменных в утилитарный модуль. Читаются при каждом
 * emit, а не на импорте: модуль импортируется раньше, чем settings.ts грузит
 * .env (запуск без pm2), и иначе LOG_LEVEL/LOG_FORMAT из .env игнорировались бы.
 * Валидацию значений делает settings.ts.
 */

type Level = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

const ORDER: Record<Level, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
};

function currentLevel(): Level {
  const v = (process.env.LOG_LEVEL || "INFO").toUpperCase();
  return v in ORDER ? (v as Level) : "INFO";
}

// секреты, которые могут прийти в лог внутри текста ошибок: токен бота (в т.ч. в URL
// Bot API …/bot123:ABC…/sendMessage) и OAuth-заголовок Яндекса. Маскируем только
// значения формы токена, чтобы обычный текст («OAuth device flow») не портился.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(bot)?\d+:[A-Za-z0-9_-]{30,}/g, "$1<token>"],
  [/OAuth (?:y0_[\w.-]+|[A-Za-z0-9_-]{20,})/g, "OAuth <token>"],
];

export function maskSecrets(msg: string): string {
  let out = msg;
  for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
  return out;
}

function emit(level: Level, name: string, rawMsg: string): void {
  if (ORDER[level] < ORDER[currentLevel()]) return;
  const msg = maskSecrets(rawMsg);
  const ts = new Date().toISOString();
  if ((process.env.LOG_FORMAT ?? "human").toLowerCase() === "json") {
    process.stdout.write(JSON.stringify({ ts, level, logger: name, msg }) + "\n");
  } else {
    const line = `${ts} ${level.padEnd(8)} [${name}] ${msg}\n`;
    if (ORDER[level] >= ORDER.ERROR) process.stderr.write(line);
    else process.stdout.write(line);
  }
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warning(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function getLogger(name: string): Logger {
  return {
    debug: (m) => emit("DEBUG", name, m),
    info: (m) => emit("INFO", name, m),
    warning: (m) => emit("WARNING", name, m),
    warn: (m) => emit("WARNING", name, m),
    error: (m) => emit("ERROR", name, m),
  };
}
