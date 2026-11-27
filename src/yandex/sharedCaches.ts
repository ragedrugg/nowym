/** Кэши, не зависящие от юзера, — общие на процесс (R1/R2). Раньше каждый
 * per-user YandexClient/SearchService держал свои LRU (лирика 1000, wave 500,
 * негатив 2000, трек-объекты 200) × до 1000 закэшированных клиентов, и один и
 * тот же текст/трек лежал в памяти по копии на юзера. */
import { LRUMap } from "../infra/lruMap.ts";
import type { YaTrack } from "./types.ts";

export interface YandexSharedCaches {
  /** track_id → текст лирики (positive, без TTL) */
  lyrics: LRUMap<string, string>;
  /** album_id → кураторский wave-цвет (positive, без TTL) */
  waveColor: LRUMap<number, string>;
  /** definitive-негатив («нет лирики» / «нет wave-агента»): ключ → момент (мс) истечения */
  negUntil: LRUMap<string, number>;
}

export function createYandexSharedCaches(): YandexSharedCaches {
  return {
    lyrics: new LRUMap<string, string>(2000),
    waveColor: new LRUMap<number, string>(2000),
    negUntil: new LRUMap<string, number>(5000),
  };
}

export const yandexSharedCaches: YandexSharedCaches = createYandexSharedCaches();

/** track_id → Track (без ссылок на lib-клиента, см. detachClient). */
export const sharedTrackObjects = new LRUMap<string, YaTrack>(2000);

/** Копия модели библиотеки без поля `client` на всех уровнях. Модели
 * @dvxch/yandex-music держат ссылку на создавший их Client (с токеном юзера);
 * в общем кэше она удерживала бы клиента (и токен) после /logout. Наш код
 * читает у трека только поля — методы моделей не нужны. */
export function detachClient<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => detachClient(v)) as T;
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k !== "client") out[k] = detachClient(v);
  }
  return out as T;
}
