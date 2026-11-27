// выгрузка альбома/плейлиста: качество «экономичное», слишком длинные треки
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Bot } from "gramio";
import type { HttpClient } from "../src/infra/http.ts";
import type { DownloadConcurrency } from "../src/infra/queue.ts";
import { AlbumService } from "../src/services/albums.ts";
import type { CacheService } from "../src/services/cache.ts";
import type { CacheDb } from "../src/storage/cache.ts";
import type { UserSettings } from "../src/storage/settings.ts";
import type { YandexClient } from "../src/yandex/client.ts";
import type { AlbumData, YaTrack } from "../src/yandex/types.ts";

const album = (tracks: YaTrack[]): AlbumData =>
  ({
    id: 7,
    title: "a",
    artist: "b",
    year: "",
    label: "",
    cover_url: "",
    genre: "",
    album_type: "",
    tracks,
    volumes: [],
  }) as AlbumData;

function harness(quality: string) {
  const log = {
    dbTiers: [] as string[],
    infoQuality: [] as string[],
    prepTiers: [] as string[],
    upTiers: [] as string[],
  };
  const edits: { text: unknown; reply_markup?: unknown }[] = [];
  const db = {
    get: async (_id: unknown, tier: string) => {
      log.dbTiers.push(tier);
      return null;
    },
    insertInflightAlbum: async () => 1,
    markInflightTrackDone: async () => undefined,
    deleteInflight: async () => undefined,
  } as unknown as CacheDb;
  const cache = {
    prepareTrackPayload: async (_id: string, _u: unknown, _m: unknown, _c: string, tier: string) => {
      log.prepTiers.push(tier);
      return [Buffer.from("x"), null];
    },
    uploadToChannel: async (id: string, _a: unknown, _c: unknown, _m: unknown, _codec: string, tier: string) => {
      log.upTiers.push(tier);
      return `F${id}`;
    },
  } as unknown as CacheService;
  const queue = { enqueue: <T>(fn: () => Promise<T>) => fn() } as unknown as DownloadConcurrency;
  const bot = {
    api: {
      sendAudio: async () => ({}),
      sendMediaGroup: async (p: { media: unknown[] }) => p.media.map(() => ({})),
      editMessageText: async (p: { text: unknown; reply_markup?: unknown }) => {
        edits.push(p);
        return {};
      },
    },
  } as unknown as Bot;
  const yandex = {
    getBestDownloadInfo: async (_t: YaTrack, q: string) => {
      log.infoQuality.push(q ?? "best");
      return { codec: q === "economy" ? "aac" : "mp3", bitrateInKbps: q === "economy" ? 192 : 320 };
    },
    directLinkFromInfo: async () => "http://x",
  } as unknown as YandexClient;
  const svc = new AlbumService(
    db,
    cache,
    queue,
    {} as HttpClient,
    bot,
    async () => ({ track_quality: quality }) as UserSettings,
  );
  const progressMsg = {
    messageId: 99,
    edit: async (text: unknown, reply_markup?: unknown) => {
      edits.push({ text, reply_markup });
    },
  };
  const send = (tracks: YaTrack[]) =>
    svc.sendAlbum({ chatId: 1, userId: 1, albumData: album(tracks), progressMsg: progressMsg as never, yandex });
  return { svc, log, edits, send };
}

const t = (id: string, durationMs = 200_000) => ({ id, title: `t${id}`, durationMs }) as unknown as YaTrack;

test("альбом, «экономичное»: economy-тир кэша, getBestDownloadInfo(economy), заливка в economy", async () => {
  const h = harness("economy");
  await h.send([t("1"), t("2")]);
  assert.deepEqual(h.log.dbTiers, ["economy", "economy"]);
  assert.deepEqual(h.log.infoQuality, ["economy", "economy"]);
  assert.deepEqual(h.log.prepTiers, ["economy", "economy"]);
  assert.deepEqual(h.log.upTiers, ["economy", "economy"]);
});

test("альбом, «оптимальное»: lossy-тир и best, как раньше", async () => {
  const h = harness("best");
  await h.send([t("1")]);
  assert.deepEqual(h.log.dbTiers, ["lossy"]);
  assert.deepEqual(h.log.infoQuality, ["best"]);
  assert.deepEqual(h.log.upTiers, ["lossy"]);
});

const FIVE_HOURS = 5 * 3600 * 1000;

test("альбом: трек > 4.5 ч — «(слишком длинный)», не в retry-буфере и не в счётчике «повторить»", async () => {
  const h = harness("best");
  // t2 не скачается (сбой), t3 — слишком длинный
  await h.svc.sendAlbum({
    chatId: 1,
    userId: 1,
    albumData: album([t("1"), t("2"), t("3", FIVE_HOURS)]),
    progressMsg: {
      messageId: 99,
      edit: async (text: unknown, reply_markup?: unknown) => {
        h.edits.push({ text, reply_markup });
      },
    } as never,
    yandex: {
      getBestDownloadInfo: async (tr: YaTrack) => (tr.id === "2" ? null : { codec: "mp3", bitrateInKbps: 320 }),
      directLinkFromInfo: async () => "http://x",
    } as unknown as YandexClient,
  });
  const last = h.edits.at(-1)!;
  const text = String((last.text as { toString(): string }).toString());
  assert.ok(text.includes("t3 (слишком длинный)"), text);
  assert.ok(text.includes("- t2"), text);
  assert.ok(text.includes("1/3"), text);
  assert.ok(JSON.stringify(last.reply_markup).includes("повторить 1 трек"), JSON.stringify(last.reply_markup));
  const buf = h.svc.peekRetry(99);
  assert.deepEqual(
    buf?.tracks.map((x) => x.id),
    ["2"],
  );
});

test("альбом: только слишком длинные не удались — кнопки «повторить» нет и буфер пуст", async () => {
  const h = harness("best");
  await h.send([t("1"), t("3", FIVE_HOURS)]);
  const last = h.edits.at(-1)!;
  assert.ok(String(last.text).includes("(слишком длинный)"));
  assert.equal(last.reply_markup, undefined);
  assert.equal(h.svc.peekRetry(99), null);
});
