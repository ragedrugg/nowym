/** русская плюрализация (склонение числительных). */

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

export function pluralTracks(n: number): string {
  return plural(n, "трек", "трека", "треков");
}

/** секунды ожидания для «подожди N сек»: вверх и не меньше 1 — Math.round давал «подожди 0 сек». */
export function waitSeconds(sec: number): number {
  return Math.max(1, Math.ceil(sec));
}

/** «@username» бота для пользовательских текстов; до getMe (или в тестах) — @nowymbot. */
export function botMention(username: string | null | undefined): string {
  return `@${username || "nowymbot"}`;
}
