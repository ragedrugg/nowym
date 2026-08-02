/** CacheService: racing-загрузка и дедуп параллельных задач.
 *
 * Оба метода приватные — дёргаем через каст, как в albums.test.ts (putRetry).
 * Сеть подделываем на уровне HttpClient.downloadAudio. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { HttpClient } from "../src/infra/http.ts";
import { CacheService, type TelegramSender, type UrlGetter } from "../src/services/cache.ts";
import type { CacheDb } from "../src/storage/cache.ts";
import type { TaggingService } from "../src/tagging/service.ts";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

type FakeDownload = (url: string, maxRetries?: number, signal?: AbortSignal) => Promise<Buffer>;

/** сервис с поддельным HttpClient — прочие зависимости в racing/dedup не участвуют. */
function mkService(downloadAudio: FakeDownload): CacheService {
  return new CacheService(
    {} as unknown as TelegramSender,
    {} as unknown as CacheDb,
    { downloadAudio } as unknown as HttpClient,
    {} as unknown as TaggingService,
  );
}

type Privates = {
  racingDownload(getUrl: UrlGetter, maxAttempts?: number, staggerMs?: number): Promise<Buffer | null>;
  withDedup<T>(map: Map<string, Promise<T>>, key: string, factory: () => Promise<T>): Promise<T>;
};
const priv = (svc: CacheService): Privates => svc as unknown as Privates;

const url: UrlGetter = async () => "https://cdn.example/track.mp3";

test("racingDownload: победитель отдаётся, проигравшие попытки реально отменяются", async () => {
  const signals: AbortSignal[] = [];
  let started = 0;

  const svc = mkService(async (_u, _retries, signal) => {
    const n = started++;
    signals.push(signal!);
    if (n === 0) {
      await new Promise((r) => setTimeout(r, 40)); // победитель отвечает позже старта остальных
      return Buffer.from("winner");
    }
    // «зависший узел CDN»: байт нет, живём до abort
    return new Promise<Buffer>((_res, rej) => {
      signal!.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
    });
  });

  const data = await priv(svc).racingDownload(url, 3, 5);

  assert.deepEqual(data, Buffer.from("winner"));
  assert.equal(signals.length, 3, "stagger 5мс < 40мс — успеть должны все три попытки");
  assert.equal(signals[1]!.aborted, true, "проигравшая попытка 2 должна быть отменена");
  assert.equal(signals[2]!.aborted, true, "проигравшая попытка 3 должна быть отменена");
});

test("racingDownload: все попытки упали → null (тот же finish), а не исключение", async () => {
  let calls = 0;
  const svc = mkService(async () => {
    calls += 1;
    throw new Error("HTTP 500");
  });

  const data = await priv(svc).racingDownload(url, 3, 5);

  assert.equal(data, null, "тотальный провал должен приходить как null, не throw");
  assert.equal(calls, 3, "ровно maxAttempts попыток, дальше finish() по failedCount");
});

test("withDedup: параллельные вызовы делят одну задачу, её падение не даёт unhandledRejection", async () => {
  // производная от .finally() — отдельный promise: без .catch() её реджект уходит
  // в unhandledRejection и задваивает admin-алерт на каждой упавшей закачке.
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown): void => void unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);

  try {
    const svc = mkService(async () => {
      throw new Error("в этом тесте сеть не трогаем");
    });
    const map = new Map<string, Promise<string>>();
    let factoryCalls = 0;
    const factory = (): Promise<string> => {
      factoryCalls += 1;
      return new Promise<string>((_r, rej) => setTimeout(() => rej(new Error("качка упала")), 10));
    };

    const first = priv(svc).withDedup(map, "42:lossy", factory);
    const second = priv(svc).withDedup(map, "42:lossy", factory);

    assert.equal(second, first, "второй вызов обязан получить ту же in-flight задачу");
    assert.equal(factoryCalls, 1, "factory не должна вызываться повторно");

    await assert.rejects(first, /качка упала/);
    await assert.rejects(second, /качка упала/, "оба ждущих получают одну и ту же ошибку");

    await tick();
    await tick(); // окно, в котором движок поднял бы unhandledRejection

    assert.deepEqual(unhandled, [], "реджект производной от .finally() должен гаситься .catch()");
    assert.equal(map.has("42:lossy"), false, "ключ снимается с map и после падения");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
