/** Парсер LRC-формата (time-synced lyrics).
 *
 * Поддерживаемые форматы меток времени:
 *   [MM:SS.cc]  — сотые секунды
 *   [MM:SS.ccc] — миллисекунды
 *   [MM:SS,ccc] — comma-разделитель (SRT-вариант)
 * Служебные теги ([ti:...], [ar:...], [al:...], ...) игнорируются. */

export interface LrcLine {
  timeMs: number;
  text: string;
}

const TIME_RE = /^\[(\d{1,2}):(\d{2})[.,](\d{1,3})\]\s*(.*)/;

export function parseLrc(lrcText: string): LrcLine[] {
  const out: LrcLine[] = [];
  for (const raw of lrcText.split(/\r?\n/)) {
    const m = TIME_RE.exec(raw.trim());
    if (!m) continue;
    const min = parseInt(m[1]!, 10);
    const sec = parseInt(m[2]!, 10);
    const frac = m[3]!;
    const fracMs =
      frac.length === 1 ? parseInt(frac, 10) * 100 : frac.length === 2 ? parseInt(frac, 10) * 10 : parseInt(frac, 10);
    const timeMs = (min * 60 + sec) * 1000 + fracMs;
    const text = m[4]!.trim();
    out.push({ timeMs, text });
  }
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

export function filterLrcLines(lines: LrcLine[]): LrcLine[] {
  return lines.filter((l) => {
    const t = l.text;
    return t.length > 0 && !/^[♪•\-–—\s]+$/.test(t);
  });
}

export function isLrc(text: string): boolean {
  return /\[\d{1,2}:\d{2}[.,]\d{1,3}\]/.test(text);
}
