/** ensureFileId — единая «взять из кэша или скачать»: ветка эффекта и kind'ы отказов. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Container } from "../src/bot/container.ts";
import { ensureFileId } from "../src/bot/handlers/inline.ts";
import type { CachedTrack } from "../src/storage/types.ts";
import type { YaTrack } from "../src/yandex/types.ts";

const entry = (fileId: string, codec: string, bitrate: number): CachedTrack =>
  ({ telegram_file_id: fileId, is_cached: true, codec, bitrate_kbps: bitrate }) as CachedTrack;

/** cacheDb.get отвечает только на запрошенный тир; calls — с какими тирами ходили в БД. */
function mkContainer(byTier: Record<string, CachedTrack>): { container: Container; calls: (string | undefined)[] } {
  const calls: (string | undefined)[] = [];
  const container = {
    cacheDb: {
      get: async (_id: string, tier?: string) => {
        calls.push(tier);
        return byTier[tier ?? ""] ?? null;
      },
    },
  } as unknown as Container;
  return { container, calls };
}

const yandex = {} as never;

test("ensureFileId — tier эффекта берёт свой тир кэша, а не оригинал", async () => {
  const { container, calls } = mkContainer({ ncore: entry("FID_NCORE", "mp3", 320) });

  const res = await ensureFileId(container, entry("FID_PLAIN", "flac", 1000), null, yandex, "42", { tier: "ncore" });
  assert.deepEqual(res, { ok: true, fileId: "FID_NCORE", codec: "mp3", bitrateKbps: 320, degraded: false });
  assert.deepEqual(calls, ["ncore"]);
});

test("ensureFileId — без tier отдаёт обычный кэш как есть", async () => {
  const { container, calls } = mkContainer({});

  const res = await ensureFileId(container, entry("FID_PLAIN", "flac", 1000), null, yandex, "42");
  assert.deepEqual(res, { ok: true, fileId: "FID_PLAIN", codec: "flac", bitrateKbps: 1000, degraded: false });
  assert.deepEqual(calls, []); // quality=best — хватает переданного cached, в БД не ходим
});

test("ensureFileId — промах кэша без трека → not_found (и с эффектом тоже)", async () => {
  const { container } = mkContainer({});
  assert.deepEqual(await ensureFileId(container, null, null, yandex, "42"), { ok: false, kind: "not_found" });
  assert.deepEqual(await ensureFileId(container, null, null, yandex, "42", { tier: "ncore" }), {
    ok: false,
    kind: "not_found",
  });
});

test("ensureFileId — слишком длинный трек → too_long, до скачивания", async () => {
  const { container } = mkContainer({});
  const long = { durationMs: 5 * 60 * 60 * 1000 } as YaTrack;
  assert.deepEqual(await ensureFileId(container, null, long, yandex, "42"), { ok: false, kind: "too_long" });
});
