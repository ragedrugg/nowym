/** Парсер LRC-формата (time-synced lyrics).
 *
 * Поддерживаемые форматы меток времени:
 *   [MM:SS.cc]  — сотые секунды (наиболее распространён в Яндексе)
 *   [MM:SS.ccc] — миллисекунды
 *   [MM:SS,ccc] — comma-разделитель (SRT-вариант)
 * Служебные теги ([ti:...], [ar:...], [al:...], ...) игнорируются. */

export interface LrcLine {
  timeMs: number;
  text: string;
}

const TIME_RE = /^\[(\d{1,2}):(\d{2})[.,](\d{1,3})\]\s*(.*)/;

/** Разбирает LRC-текст в массив строк с таймкодами. */
export function parseLrc(lrcText: string): LrcLine[] {
  const out: LrcLine[] = [];
  for (const raw of lrcText.split(/\r?\n/)) {
    const m = TIME_RE.exec(raw.trim());
    if (!m) continue;
    const min = parseInt(m[1]!, 10);
    const sec = parseInt(m[2]!, 10);
    const frac = m[3]!;
    // нормализуем дробь к миллисекундам (десятые → ×100, сотые → ×10, миллисекунды → ×1)
    const fracMs =
      frac.length === 1 ? parseInt(frac, 10) * 100 : frac.length === 2 ? parseInt(frac, 10) * 10 : parseInt(frac, 10);
    const timeMs = (min * 60 + sec) * 1000 + fracMs;
    const text = m[4]!.trim();
    out.push({ timeMs, text });
  }
  // сортируем на случай нарушенного порядка
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

/** Убирает пустые строки и системные LRC-метаданные (только [...]). */
export function filterLrcLines(lines: LrcLine[]): LrcLine[] {
  return lines.filter((l) => {
    const t = l.text;
    // пустая строка или строка-пауза (♪, •, -) → пропускаем
    return t.length > 0 && !/^[♪•\-–—\s]+$/.test(t);
  });
}

/** Возвращает true, если текст содержит хотя бы один LRC-таймкод. */
export function isLrc(text: string): boolean {
  return /\[\d{1,2}:\d{2}[.,]\d{1,3}\]/.test(text);
}
