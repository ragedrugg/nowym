import { test } from "node:test";
import assert from "node:assert/strict";
import { AlbumService, renderProgressBar, formatEta } from "../src/services/albums.ts";
import type { CacheDb } from "../src/storage/cache.ts";
import type { CacheService } from "../src/services/cache.ts";
import type { DownloadConcurrency } from "../src/infra/queue.ts";
import type { HttpClient } from "../src/infra/http.ts";
import type { Bot } from "gramio";
import type { UserSettings } from "../src/storage/settings.ts";
import type { AlbumData, YaTrack } from "../src/yandex/types.ts";
import type { YandexClient } from "../src/yandex/client.ts";

function mkService(): AlbumService {
  return new AlbumService(
    {} as unknown as CacheDb,
    {} as unknown as CacheService,
    {} as unknown as DownloadConcurrency,
    {} as unknown as HttpClient,
    {} as unknown as Bot,
    async (): Promise<UserSettings> => {
      throw new Error("не должен вызываться — тестируем только синхронный gate/retry-буфер");
    },
  );
}

function mkRetryBuf(over: Partial<{ chatId: number; userId: number }> = {}) {
  return {
    chatId: over.chatId ?? 1,
    userId: over.userId ?? 2,
    tracks: [] as YaTrack[],
    albumData: {} as AlbumData,
    yandex: {} as YandexClient,
  };
}

test("tryBegin/release — синхронный gate против TOCTOU-гонки на параллельный старт выгрузки", () => {
  const svc = mkService();
  assert.equal(svc.tryBegin(1), true);
  assert.equal(svc.tryBegin(1), false, "второй параллельный старт того же юзера не должен пройти");
  assert.equal(svc.isActive(1), true);
  assert.equal(svc.isActive(2), false, "другой юзер не задет");

  svc.release(1);
  assert.equal(svc.isActive(1), false);
  assert.equal(svc.tryBegin(1), true, "после release снова можно начать");
});

test("cancel — false для неактивного юзера, true для активного", () => {
  const svc = mkService();
  assert.equal(svc.cancel(1), false);
  svc.tryBegin(1);
  assert.equal(svc.cancel(1), true);
});

test("peekRetry — не удаляет запись; popRetry — удаляет", () => {
  const svc = mkService();
  const buf = mkRetryBuf();
  (svc as unknown as { putRetry(id: number, b: typeof buf): void }).putRetry(100, buf);

  assert.deepEqual(svc.peekRetry(100), buf);
  assert.deepEqual(svc.peekRetry(100), buf, "повторный peek не должен трогать буфер");
  assert.deepEqual(svc.popRetry(100), buf);
  assert.equal(svc.popRetry(100), null, "после pop буфер пуст");
});

test("peekRetry/popRetry — несуществующий messageId → null", () => {
  const svc = mkService();
  assert.equal(svc.peekRetry(999), null);
  assert.equal(svc.popRetry(999), null);
});

test("peekRetry/popRetry — запись старше TTL (30 мин) не отдаётся", () => {
  const svc = mkService();
  const buf = mkRetryBuf();
  const realNow = Date.now;
  try {
    Date.now = () => 1_000_000;
    (svc as unknown as { putRetry(id: number, b: typeof buf): void }).putRetry(100, buf);

    Date.now = () => 1_000_000 + 1_800_001; // за порогом RETRY_BUFFER_TTL_MS
    assert.equal(svc.peekRetry(100), null);
    assert.equal(svc.popRetry(100), null);
  } finally {
    Date.now = realNow;
  }
});

test("renderProgressBar", () => {
  assert.equal(renderProgressBar(0, 10), "░".repeat(16));
  assert.equal(renderProgressBar(10, 10), "▓".repeat(16));
  assert.equal(renderProgressBar(5, 10), "▓".repeat(8) + "░".repeat(8));
  assert.equal(renderProgressBar(0, 0), "░".repeat(16), "total=0 не должен делить на ноль");
});

test("formatEta", () => {
  assert.equal(formatEta(5), "0:05");
  assert.equal(formatEta(65), "1:05");
  assert.equal(formatEta(3661), "1:01:01");
  assert.equal(formatEta(-1), "?");
  assert.equal(formatEta(NaN), "?");
});
