import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramError } from "yaebal";
import type { ApiBot as Bot } from "../src/bot/types.ts";
import type { HttpClient } from "../src/infra/http.ts";
import type { DownloadConcurrency } from "../src/infra/queue.ts";
import { Semaphore } from "../src/infra/semaphore.ts";
import { AlbumService, formatEta, renderProgressBar } from "../src/services/albums.ts";
import type { CacheService } from "../src/services/cache.ts";
import type { CacheDb } from "../src/storage/cache.ts";
import type { UserSettings } from "../src/storage/settings.ts";
import type { YandexClient } from "../src/yandex/client.ts";
import type { AlbumData, YaTrack } from "../src/yandex/types.ts";

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

// --- D1/D2: слот выгрузки освобождается при исключениях до основного цикла ---

function mkServiceWith(db: Partial<CacheDb>, getUserSettings: (userId: number) => Promise<UserSettings>): AlbumService {
  return new AlbumService(
    db as unknown as CacheDb,
    {} as unknown as CacheService,
    {} as unknown as DownloadConcurrency,
    {} as unknown as HttpClient,
    {} as unknown as Bot,
    getUserSettings,
  );
}

const oneTrackAlbum = (): AlbumData =>
  ({
    id: 7,
    title: "a",
    artist: "b",
    year: "",
    label: "",
    cover_url: "",
    genre: "",
    album_type: "",
    tracks: [{ id: "1", title: "t" } as unknown as YaTrack],
    volumes: [],
  }) as AlbumData;

test("D1: getUserSettings упал (pg моргнул) — слот выгрузки освобождён", async () => {
  const svc = mkServiceWith({}, async () => {
    throw new Error("pg down");
  });
  assert.equal(svc.tryBegin(1), true);
  await assert.rejects(
    svc.sendAlbum({ chatId: 1, userId: 1, albumData: oneTrackAlbum(), progressMsg: null, yandex: {} as YandexClient }),
    /pg down/,
  );
  assert.equal(svc.isActive(1), false, "слот должен освободиться в finally");
  assert.equal(svc.tryBegin(1), true, "новая выгрузка снова возможна");
});

test("D1: пустой список треков — слот, занятый tryBegin, освобождён", async () => {
  const svc = mkServiceWith({}, async () => ({}) as UserSettings);
  svc.tryBegin(1);
  await svc.sendAlbum({
    chatId: 1,
    userId: 1,
    albumData: { ...oneTrackAlbum(), tracks: [] },
    progressMsg: null,
    yandex: {} as YandexClient,
  });
  assert.equal(svc.isActive(1), false);
});

test("D1: retryFailed — getUserSettings упал, слот освобождён", async () => {
  const svc = mkServiceWith({}, async () => {
    throw new Error("pg down");
  });
  await assert.rejects(
    svc.retryFailed({
      chatId: 1,
      userId: 1,
      tracks: oneTrackAlbum().tracks,
      albumData: oneTrackAlbum(),
      progressMsg: null,
      yandex: {} as YandexClient,
    }),
  );
  assert.equal(svc.isActive(1), false);
});

function inflightDb(): Partial<CacheDb> {
  return {
    listInflight: async () => [
      {
        id: 5,
        user_id: 1,
        chat_id: 1,
        album_id: 7,
        playlist_owner: null,
        progress_message_id: null,
        completed_track_ids: [],
      },
    ],
    deleteOldInflight: async () => 0,
    deleteInflight: async () => {},
  };
}

test("D2: resume — resolveToken бросил, слот освобождён", async () => {
  const svc = mkServiceWith(inflightDb(), async () => ({}) as UserSettings);
  await svc.resumeInflight({
    resolveToken: async () => {
      throw new Error("pg down");
    },
    getYandexClient: async () => ({}) as YandexClient,
  });
  assert.equal(svc.isActive(1), false);
});

test("D2: resume — getYandexClient (lib.init) бросил, слот освобождён", async () => {
  const svc = mkServiceWith(inflightDb(), async () => ({}) as UserSettings);
  await svc.resumeInflight({
    resolveToken: async () => "tok",
    getYandexClient: async () => {
      throw new Error("network");
    },
  });
  assert.equal(svc.isActive(1), false);
});

test("D2: resume — deleteInflight бросил на ветке «нет токена», слот освобождён", async () => {
  const svc = mkServiceWith(
    {
      ...inflightDb(),
      deleteInflight: async () => {
        throw new Error("pg down");
      },
    },
    async () => ({}) as UserSettings,
  );
  await svc.resumeInflight({ resolveToken: async () => null, getYandexClient: async () => ({}) as YandexClient });
  assert.equal(svc.isActive(1), false);
});

// --- D3: плейлист в album_inflight — по (owner, kind), а не getAlbum(kind) ---

test("D3: sendAlbum плейлиста пишет playlist_owner в inflight", async () => {
  const inserted: unknown[] = [];
  const svc = mkServiceWith(
    {
      insertInflightAlbum: async (args) => {
        inserted.push(args);
        throw new Error("стоп после insert");
      },
    },
    async () => ({ track_quality: "lossy" }) as UserSettings,
  );
  // insert упал → inflightId=null, дальше выгрузка; останавливаем её отменой до первой волны
  svc.tryBegin(1);
  svc.cancel(1);
  await svc.sendAlbum({
    chatId: 1,
    userId: 1,
    albumData: { ...oneTrackAlbum(), id: 42, album_type: "playlist", playlist_owner: "alice" },
    progressMsg: null,
    yandex: {} as YandexClient,
  });
  assert.deepEqual(inserted, [
    { user_id: 1, chat_id: 1, album_id: 42, playlist_owner: "alice", progress_message_id: null },
  ]);
});

test("D3: resume плейлиста зовёт getPlaylist(owner, kind), а не getAlbum(kind)", async () => {
  const calls: string[] = [];
  const deleted: number[] = [];
  const svc = mkServiceWith(
    {
      listInflight: async () => [
        {
          id: 9,
          user_id: 1,
          chat_id: 1,
          album_id: 42,
          playlist_owner: "alice",
          progress_message_id: null,
          completed_track_ids: [1],
        },
      ],
      deleteOldInflight: async () => 0,
      deleteInflight: async (id) => {
        deleted.push(id);
      },
    },
    async () => ({}) as UserSettings,
  );
  const yandex = {
    getAlbum: async (id: number) => {
      calls.push(`album:${id}`);
      return null;
    },
    getPlaylist: async (owner: string, kind: number) => {
      calls.push(`playlist:${owner}/${kind}`);
      return { ...oneTrackAlbum(), id: kind, album_type: "playlist", playlist_owner: owner };
    },
  } as unknown as YandexClient;
  await svc.resumeInflight({ resolveToken: async () => "tok", getYandexClient: async () => yandex });
  assert.deepEqual(calls, ["playlist:alice/42"]);
  assert.deepEqual(deleted, [9], "все треки уже залиты → строка inflight удалена");
  assert.equal(svc.isActive(1), false);
});

test("D3: resume альбома (playlist_owner=null) по-прежнему зовёт getAlbum", async () => {
  const calls: string[] = [];
  const svc = mkServiceWith(inflightDb(), async () => ({}) as UserSettings);
  const yandex = {
    getAlbum: async (id: number) => {
      calls.push(`album:${id}`);
      return null;
    },
    getPlaylist: async () => {
      calls.push("playlist");
      return null;
    },
  } as unknown as YandexClient;
  await svc.resumeInflight({ resolveToken: async () => "tok", getYandexClient: async () => yandex });
  assert.deepEqual(calls, ["album:7"]);
});

// --- D8: 429 при отправке пачки в чат юзера ретраится, а не валит всю пачку ---

function floodBot(calls: string[]): Bot {
  let n = 0;
  const flaky = (method: string, result: () => unknown) => async () => {
    calls.push(method);
    n += 1;
    if (n === 1) throw new TelegramError(method, 429, "Too Many Requests", { retry_after: 0 });
    return result();
  };
  return {
    api: {
      sendMediaGroup: flaky("sendMediaGroup", () => [{}, {}]),
      sendAudio: flaky("sendAudio", () => ({})),
    },
  } as unknown as Bot;
}

function mkProgress() {
  return {
    sent: 0,
    downloading: 0,
    failed: [] as YaTrack[],
    lock: new Semaphore(1),
    startedAt: 0,
    lastRender: 0,
    nowSending: null,
  };
}

const cachedEntry = (id: string) => ({
  kind: "cached",
  track: { id, title: id } as unknown as YaTrack,
  trackId: id,
  metadata: { duration: 1 },
  fileId: `F${id}`,
  payload: null,
  codec: "mp3",
  tier: "lossy",
});

type SendBatch = (
  chatId: number,
  batch: unknown[],
  progress: ReturnType<typeof mkProgress>,
  total: number,
  msg: null,
  header: string,
  markDone: (tid: string) => Promise<void>,
) => Promise<void>;

for (const [label, batch] of [
  ["sendMediaGroup", [cachedEntry("1"), cachedEntry("2")]],
  ["sendAudio", [cachedEntry("1")]],
] as const) {
  test(`D8: ${label} — 429 ретраится, пачка доходит`, async () => {
    const calls: string[] = [];
    const svc = new AlbumService(
      {} as unknown as CacheDb,
      {} as unknown as CacheService,
      {} as unknown as DownloadConcurrency,
      {} as unknown as HttpClient,
      floodBot(calls),
      async () => ({}) as UserSettings,
    );
    const progress = mkProgress();
    const done: string[] = [];
    await (svc as unknown as { sendBatch: SendBatch }).sendBatch(
      1,
      [...batch],
      progress,
      batch.length,
      null,
      "h",
      async (t) => {
        done.push(t);
      },
    );
    assert.deepEqual(calls, [label, label], "второй вызов после 429");
    assert.equal(progress.sent, batch.length);
    assert.equal(progress.failed.length, 0);
    assert.deepEqual(
      done,
      batch.map((e) => e.trackId),
    );
  });
}

test("D17: forgetUser выкидывает retry-буферы юзера (держат YandexClient), чужие не трогает", () => {
  const svc = mkService();
  const put = (id: number, b: ReturnType<typeof mkRetryBuf>) =>
    (svc as unknown as { putRetry(id: number, b: ReturnType<typeof mkRetryBuf>): void }).putRetry(id, b);
  put(100, mkRetryBuf({ userId: 2 }));
  put(101, mkRetryBuf({ userId: 2 }));
  put(102, mkRetryBuf({ userId: 3 }));
  svc.forgetUser(2);
  assert.equal(svc.peekRetry(100), null);
  assert.equal(svc.peekRetry(101), null);
  assert.notEqual(svc.peekRetry(102), null);
});

test("D12: startUpload — лимит с retryAfter < 0.5 с показывает «подожди 1 сек», а не 0", async () => {
  const { startUpload } = await import("../src/bot/handlers/albums.ts");
  const sent: string[] = [];
  const bot = {
    api: {
      sendMessage: async (p: { text: unknown }) => {
        sent.push(String(p.text));
        return { message_id: 1 };
      },
    },
  } as unknown as Bot;
  const container = { downloadLimiter: { check: () => [false, 0.3] } } as never;
  await startUpload(bot, 1, 1, container, "альбом", "nf" as never, async () => null);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /подожди 1 сек/);
});
