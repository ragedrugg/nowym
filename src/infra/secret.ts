import { timingSafeEqual } from "node:crypto";

/** Сравнение секрета в постоянном времени. Пустой expected → всегда false
 * (fail closed): незаданный секрет не должен превращаться в «пускаем всех». */
export function secretMatches(header: string | undefined, expected: string): boolean {
  if (!expected || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
