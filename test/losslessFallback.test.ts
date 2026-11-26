/** Item L + P4A: lossless через tracksFileInfo (raw, без расшифровки), lossy-ответ
 * на lossless-запрос = деградация, проверка магии до кэша, ресвежение URL, health-проба.
 * Без сети: fake lib / fake http / fake sender. */
import { strict as assert } from "node:assert";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { Container } from "../src/bot/container.ts";
import { ensureFileId } from "../src/bot/handlers/inline.ts";
import type { HttpClient } from "../src/infra/http.ts";
import { CacheService, type TelegramSender } from "../src/services/cache.ts";
import type { CacheDb } from "../src/storage/cache.ts";
import type { TaggingService } from "../src/tagging/service.ts";
import * as clientModule from "../src/yandex/client.ts";
import { YandexClient } from "../src/yandex/client.ts";
import type { YaTrack } from "../src/yandex/types.ts";

const FTYP = Buffer.concat([Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70]), Buffer.from("isom....")]);

const fileInfo = (codec: string) => ({
  downloadInfo: {
    codec,
    bitrate: 0,
    transport: "raw",
    urls: ["https://cdn/a", "https://cdn/b"],
    isLossless: codec === "flac" || codec === "flac-mp4",
    links() {
      return this.urls;
    },
  },
});

function withLib(lib: unknown): YandexClient {
  const client = new YandexClient("t");
  (client as unknown as { lib: unknown }).lib = lib;
  return client;
}

// ---------- ITEM L: клиент ----------

test("getLosslessDownload: tracksFileInfo(bare id, {quality:'lossless'}), без encraw/ключа", async () => {
  const calls: unknown[][] = [];
  const client = withLib({
    tracksFileInfo: async (...args: unknown[]) => {
      calls.push(args);
      return fileInfo("flac-mp4");
    },
    tracksLosslessInfo: async () => assert.fail("encraw-путь не должен вызываться"),
  });
  const info = await client.getLosslessDownload({ id: "123:456" } as never);
  assert.deepEqual(calls, [["123", { quality: "lossless" }]]);
  assert.equal(info?.codec, "flac-mp4");
  assert.equal(info?.key, undefined);
});

test("getLosslessDownload: lossy-ответ (aac-mp4) на lossless-запрос → null (не lossless)", async () => {
  const lossy = async () => fileInfo("aac-mp4");
  const client = withLib({ tracksFileInfo: lossy, tracksLosslessInfo: async () => (await lossy()).downloadInfo });
  assert.equal(await client.getLosslessDownload({ id: "1" } as never), null);
});

test("getLosslessDownload: пустой id → null без запроса", async () => {
  const client = withLib({ tracksFileInfo: async () => assert.fail("запроса быть не должно") });
  assert.equal(await client.getLosslessDownload({ id: undefined } as never), null);
});

test("makeEncrawDecrypt удалён из клиента", () => {
  assert.equal("makeEncrawDecrypt" in clientModule, false);
});

// ---------- P4A: lossy-ответ не кэшируется как lossless ----------

test("ensureFileId(lossless): lossy-ответ → degraded=true, кэш в lossy-тир", async () => {
  const tiers: string[] = [];
  const container = {
    cacheDb: { get: async () => null },
    cacheService: {
      downloadAndCacheTrack: async (...args: unknown[]) => {
        tiers.push(args.includes("lossless") ? "lossless" : "lossy");
        return "FID";
      },
    },
  } as unknown as Container;
  const yandex = withLib({
    tracksFileInfo: async () => fileInfo("aac-mp4"),
    tracksLosslessInfo: async () => fileInfo("aac-mp4").downloadInfo,
    tracksDownloadInfo: async () => [
      { codec: "mp3", bitrateInKbps: 320, getDirectLink: async () => "https://cdn/x.mp3" },
    ],
  });
  const track = { id: "42", title: "t", artists: [{ name: "a" }], durationMs: 1000 } as unknown as YaTrack;
  const res = await ensureFileId(container, null, track, yandex, "42", { quality: "lossless" });
  assert.deepEqual(tiers, ["lossy"]);
  assert.equal(res.ok && res.degraded, true);
  assert.equal(res.ok && res.codec, "mp3");
});

// ---------- ресвежение URL ----------

test("losslessUrlPicker: до TTL — тот же список, после TTL — один раз повторный запрос info", async () => {
  let now = 0;
  let refetches = 0;
  const info = { links: () => ["https://old"] } as never;
  const fresh = { links: () => ["https://new"] } as never;
  const pick = clientModule.losslessUrlPicker(
    info,
    async () => {
      refetches++;
      return fresh;
    },
    { now: () => now, ttlMs: 1000 },
  );
  assert.equal(await pick(), "https://old");
  now = 999;
  assert.equal(await pick(), "https://old");
  now = 1500;
  assert.equal(await pick(), "https://new");
  now = 99_999;
  assert.equal(await pick(), "https://new", "второй раз не обновляем — ограничено одним");
  assert.equal(refetches, 1);
});

test("losslessUrlPicker: refetch упал/пуст → остаёмся на старых ссылках", async () => {
  let now = 0;
  const pick = clientModule.losslessUrlPicker({ links: () => ["https://old"] } as never, async () => null, {
    now: () => now,
    ttlMs: 10,
  });
  now = 100;
  assert.equal(await pick(), "https://old");
});

// ---------- магия до тегов и кэша ----------

function mkCache(download: (url: string) => Promise<Buffer>) {
  const state = { tagged: 0, sent: 0, saved: [] as unknown[][] };
  const svc = new CacheService(
    {
      sendAudioToChannel: async () => {
        state.sent++;
        return { fileId: "FID", messageId: 1 };
      },
      deleteChannelMessage: async () => {},
    } as unknown as TelegramSender,
    {
      get: async () => null,
      save: async (...a: unknown[]) => {
        state.saved.push(a);
      },
    } as unknown as CacheDb,
    { downloadAudio: download } as unknown as HttpClient,
    {
      addMetadata: async (b: Buffer) => {
        state.tagged++;
        return b;
      },
    } as unknown as TaggingService,
  );
  return { svc, state };
}
const meta = { artist: "a", title: "t", album: "", duration: 10, cover_url: "", cover_data: null } as never;

test("мусор вместо flac-mp4: не тегируем, не заливаем, file_id не пишем", async () => {
  const { svc, state } = mkCache(async () => Buffer.from("<html>error</html>-padding"));
  const fileId = await svc.downloadAndCacheTrack("1", async () => "https://cdn/a", meta, "flac-mp4", "lossless");
  assert.equal(fileId, null);
  assert.deepEqual([state.tagged, state.sent, state.saved.length], [0, 0, 0]);
});

test("валидный ftyp: тегируем, заливаем, пишем под тир lossless", async () => {
  const { svc, state } = mkCache(async () => FTYP);
  const fileId = await svc.downloadAndCacheTrack("1", async () => "https://cdn/a", meta, "flac-mp4", "lossless");
  assert.equal(fileId, "FID");
  assert.equal(state.tagged, 1);
  assert.equal(state.saved[0]?.[state.saved[0].length - 1], "lossless");
});

test("гонка: мусорный ответ — проваленная попытка, следующая с корректными байтами побеждает", async () => {
  let n = 0;
  const { svc } = mkCache(async () => (n++ === 0 ? Buffer.from("garbage-garbage") : FTYP));
  const data = await (
    svc as unknown as {
      racingDownload(g: () => Promise<string>, a: number, s: number, o: number, codec: string): Promise<Buffer | null>;
    }
  ).racingDownload(async () => "https://cdn/a", 3, 1, 5000, "flac-mp4");
  assert.deepEqual(data, FTYP);
});

// ---------- health-проба lossless ----------

function healthLib(fileInfoFor: (id: string) => Promise<unknown>, seen: string[]) {
  return {
    request: { get: async () => ({}) },
    accountStatus: async () => ({ account: { serviceAvailable: true } }),
    search: async () => ({ tracks: { results: [{ id: "9" }] } }),
    tracks: async () => [{ id: "9", title: "T", artists: [{ name: "A" }] }],
    tracksDownloadInfo: async () => [
      { codec: "mp3", bitrateInKbps: 320, getDirectLink: async () => "https://cdn/l.mp3" },
    ],
    tracksFileInfo: async (id: string) => {
      seen.push(id);
      return fileInfoFor(id);
    },
    tracksLyrics: async () => ({ fetchLyrics: async () => "text" }),
    usersLikesTracks: async () => ({ tracks: [] }),
    musicHistory: async () => ({ historyTabs: [] }),
  };
}

const httpWith = (head: Buffer, gets: string[] = []) =>
  ({
    request: async (url: string, o: { headers?: Record<string, string> }) => {
      gets.push(`${url} ${o?.headers?.Range ?? ""}`);
      return { status: 206, headers: {}, body: Readable.from([head]) };
    },
    headOrRange: async () => ({ status: 200 }),
  }) as unknown as HttpClient;

test("health: первая lossless-проба упала → пробуем следующий id", async () => {
  const seen: string[] = [];
  const client = withLib(
    healthLib(async () => {
      if (seen.length === 1) throw new Error("boom");
      return fileInfo("flac-mp4");
    }, seen),
  );
  const report = await client.probeApiHealth({ http: httpWith(FTYP) });
  assert.deepEqual(seen, ["117708948", "51516485"]);
  const c = report.checks.find((x) => x.key === "download_lossless");
  assert.equal(c?.status, "ok", c?.detail ?? "");
});

test("health: lossy-ответ на lossless-пробу → degraded, не ok", async () => {
  const client = withLib(healthLib(async () => fileInfo("aac-mp4"), []));
  const report = await client.probeApiHealth({ http: httpWith(FTYP) });
  assert.equal(report.overall, "degraded");
  assert.equal(report.checks.find((x) => x.key === "download_lossless")?.status, "fail");
});

test("health: CDN-проба lossless читает первые байты Range и проверяет магию", async () => {
  const gets: string[] = [];
  const bad = withLib(healthLib(async () => fileInfo("flac-mp4"), []));
  const rBad = await bad.probeApiHealth({ http: httpWith(Buffer.from("<html>nope</html>"), gets) });
  assert.equal(rBad.checks.find((x) => x.key === "cdn")?.status, "fail");
  assert.match(gets[0] ?? "", /bytes=0-/);
  const good = withLib(healthLib(async () => fileInfo("flac-mp4"), []));
  const rGood = await good.probeApiHealth({ http: httpWith(FTYP) });
  assert.equal(rGood.checks.find((x) => x.key === "cdn")?.status, "ok");
});
