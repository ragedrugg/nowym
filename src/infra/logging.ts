/**
 * Лёгкий логгер с уровнями и human/json-форматом, без зависимостей.
 * Уровень/формат читаются прямо из env, а не через settings — чтобы не тянуть
 * валидацию обязательных переменных в утилитарный модуль.
 */

type Level = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

const ORDER: Record<Level, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
};

const LEVEL: Level = ((): Level => {
  const v = (process.env.LOG_LEVEL ?? "INFO").toUpperCase();
  return v in ORDER ? (v as Level) : "INFO";
})();

const JSON_FORMAT = (process.env.LOG_FORMAT ?? "human").toLowerCase() === "json";

function emit(level: Level, name: string, msg: string): void {
  if (ORDER[level] < ORDER[LEVEL]) return;
  const ts = new Date().toISOString();
  if (JSON_FORMAT) {
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
