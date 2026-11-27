// ссылки на плейлист: логин владельца с точкой в inline, формат «поделиться» /playlists/<uuid>
import assert from "node:assert/strict";
import { test } from "node:test";
import { startAlbumUpload } from "../src/bot/handlers/albums.ts";
import { registerPlaylists, startPlaylistUpload } from "../src/bot/handlers/playlists.ts";
import { DEEPLINK_OWNER_RE, PLAYLIST_URL_RE, parseSearchQuery } from "../src/infra/parsers.ts";
import { SearchService } from "../src/services/search.ts";
import { YandexClient, YandexUnavailableError } from "../src/yandex/client.ts";

const UUID = "0b2ff8b8-5a1f-4e4e-9a6e-1c2d3e4f5a6b";

test("parse: /playlists/<uuid> и /playlists/lk.<uuid> → playlist_uuid_link", () => {
  assert.deepEqual(parseSearchQuery(`https://music.yandex.ru/playlists/${UUID}?utm_source=share`), {
    type: "playlist_uuid_link",
    uuid: UUID,
  });
  assert.deepEqual(parseSearchQuery(`https://music.yandex.ru/playlists/lk.${UUID}`), {
    type: "playlist_uuid_link",
    uuid: `lk.${UUID}`,
  });
  assert.deepEqual(parseSearchQuery(`music.yandex.com/playlists/${UUID.toUpperCase()}`), {
    type: "playlist_uuid_link",
    uuid: UUID,
  });
  // не uuid — обычный поиск
  assert.equal(parseSearchQuery("https://music.yandex.ru/playlists/abc").type, "search");
  // старый формат не задет
  assert.equal(parseSearchQuery("https://music.yandex.ru/users/a.b/playlists/3").type, "playlist_link");
});

test("owner с точкой: PLAYLIST_URL_RE его принимает, deep-link — нет (общие константы parsers.ts)", () => {
  assert.equal(PLAYLIST_URL_RE.exec("music.yandex.ru/users/ya.playlist/playlists/1")?.[1], "ya.playlist");
  assert.equal(DEEPLINK_OWNER_RE.test("ya.playlist"), false);
  assert.equal(DEEPLINK_OWNER_RE.test("some_user-1"), true);
});

function svcWith(yandex: Record<string, unknown>): SearchService {
  return new SearchService(yandex as never, new Map() as never, null, "nowymbot");
}

const short = { title: "Мой", coverUri: "", trackCount: 3 };

test("inline: плейлист владельца с точкой → статья без deep-link и с подсказкой про личку (не «не найдено»)", async () => {
  const svc = svcWith({ getPlaylistShort: async () => short });
  const res = (await svc.searchAndCreateResults("https://music.yandex.ru/users/ya.playlist/playlists/1035")) as {
    id: string;
    description?: string;
    reply_markup?: unknown;
  }[];
  assert.equal(res.length, 1);
  assert.equal(res[0]!.id, "playlist:ya.playlist:1035");
  assert.equal(res[0]!.reply_markup, undefined);
  assert.ok(res[0]!.description?.includes("в личку"), res[0]!.description);
});

test("inline: плейлист по uuid-ссылке → резолв в (uid, kind), статья с deep-link playlist_<uid>_<kind>", async () => {
  const seen: unknown[] = [];
  const svc = svcWith({
    resolvePlaylistUuid: async (u: string) => {
      seen.push(u);
      return { owner: "12345", kind: 7 };
    },
    getPlaylistShort: async (owner: string, kind: number) => {
      seen.push([owner, kind]);
      return short;
    },
  });
  const res = (await svc.searchAndCreateResults(`https://music.yandex.ru/playlists/lk.${UUID}`)) as {
    id: string;
    reply_markup?: unknown;
  }[];
  assert.deepEqual(seen, [`lk.${UUID}`, ["12345", 7]]);
  assert.equal(res[0]!.id, "playlist:12345:7");
  assert.ok(JSON.stringify(res[0]!.reply_markup).includes("start=playlist_12345_7"));
});

test("inline: uuid не резолвится → пусто (без падения)", async () => {
  const svc = svcWith({ resolvePlaylistUuid: async () => null, getPlaylistShort: async () => short });
  assert.deepEqual(await svc.searchAndCreateResults(`https://music.yandex.ru/playlists/${UUID}`), []);
});

test("YandexClient.resolvePlaylistUuid: lib.playlist(uuid) → owner=uid строкой, kind", async () => {
  const client = new YandexClient("t");
  const asked: string[] = [];
  (client as unknown as { lib: unknown }).lib = {
    playlist: async (u: string) => {
      asked.push(u);
      return { uid: 1, owner: { uid: 777, login: "a.b" }, kind: 1003 };
    },
  };
  assert.deepEqual(await client.resolvePlaylistUuid(UUID), { owner: "777", kind: 1003 });
  assert.deepEqual(asked, [UUID]);
});

test("YandexClient.resolvePlaylistUuid: нет kind/uid или ошибка → null", async () => {
  const client = new YandexClient("t");
  (client as unknown as { lib: unknown }).lib = { playlist: async () => ({ title: "x" }) };
  assert.equal(await client.resolvePlaylistUuid(UUID), null);
  (client as unknown as { lib: unknown }).lib = {
    playlist: async () => {
      throw new Error("nf");
    },
  };
  assert.equal(await client.resolvePlaylistUuid(UUID), null);
});

test("лс: uuid-ссылка на плейлист ловится своим матчером", async () => {
  // yaebal: матчеры ссылок — on("message") с next() на промах (hears yaebal ловил бы и правки)
  const handlers: ((ctx: unknown, next: () => Promise<void>) => Promise<void>)[] = [];
  const bot = { on: (_ev: string, h: (typeof handlers)[number]) => handlers.push(h) };
  registerPlaylists(bot as never, {} as never);
  let claimed = 0;
  for (const h of handlers) {
    let nexted = false;
    // не личка: подходящий матчер забирает апдейт и сразу выходит, остальные зовут next()
    await h({ chat: { type: "group" }, text: `https://music.yandex.ru/playlists/${UUID}` }, async () => {
      nexted = true;
    });
    if (!nexted) claimed++;
  }
  assert.equal(claimed, 1);
});

// ---------- review-2 L3: сбой Яндекса на ссылках альбома/плейлиста ≠ «не найдено» ----------

const strictDown = async (...args: unknown[]) => {
  const o = args.at(-1) as { strict?: boolean } | undefined;
  if (o?.strict) throw new YandexUnavailableError("x", new Error("503"));
  return null;
};

test("inline: ссылки на альбом/плейлист при сбое Яндекса → YandexUnavailableError (а не пустая выдача)", async () => {
  const svc = svcWith({
    getAlbumShort: strictDown,
    resolvePlaylistUuid: strictDown,
    getPlaylistShort: strictDown,
  });
  await assert.rejects(svc.searchAndCreateResults("https://music.yandex.ru/album/123"), YandexUnavailableError);
  await assert.rejects(svc.searchAndCreateResults(`https://music.yandex.ru/playlists/${UUID}`), YandexUnavailableError);
  await assert.rejects(
    svc.searchAndCreateResults("https://music.yandex.ru/users/someone/playlists/3"),
    YandexUnavailableError,
  );
});

function dmUploadHarness(yandex: Record<string, unknown>) {
  const texts: string[] = [];
  let released = 0;
  const bot = {
    api: {
      sendMessage: async (p: { text: unknown }) => {
        texts.push(JSON.stringify(p.text));
        return { message_id: 5 };
      },
      editMessageText: async (p: { text: unknown }) => {
        texts.push(JSON.stringify(p.text));
        return true;
      },
    },
  };
  const container = {
    downloadLimiter: { check: () => [true, 0] },
    resolveToken: async () => "tok",
    albumService: {
      tryBegin: () => true,
      release: () => {
        released++;
      },
    },
    getYandexService: async () => yandex,
  };
  return { bot: bot as never, container: container as never, texts, released: () => released };
}

test("лс: плейлист по ссылке при сбое Яндекса → «Яндекс не отвечает», слот освобождён", async () => {
  const h = dmUploadHarness({ getPlaylist: strictDown });
  await startPlaylistUpload(h.bot, 10, 1, "someone", 3, h.container);
  assert.ok(h.texts.at(-1)!.includes("Яндекс не отвечает"), h.texts.at(-1));
  assert.equal(h.released(), 1);
});

test("лс: плейлист по uuid-ссылке при сбое Яндекса → «Яндекс не отвечает»", async () => {
  const handlers: ((ctx: unknown, next: () => Promise<void>) => Promise<void>)[] = [];
  const h = dmUploadHarness({ resolvePlaylistUuid: strictDown, getPlaylist: strictDown });
  const on = (_ev: string, fn: (typeof handlers)[number]) => handlers.push(fn);
  registerPlaylists({ on, api: (h.bot as unknown as { api: unknown }).api } as never, h.container);
  const text = `https://music.yandex.ru/playlists/${UUID}`;
  // цепочка как у composer: каждый матчер на промахе зовёт next()
  const dispatch = (i: number): Promise<void> =>
    i < handlers.length
      ? handlers[i]!({ chat: { type: "private", id: 10 }, from: { id: 1 }, text }, () => dispatch(i + 1))
      : Promise.resolve();
  await dispatch(0);
  assert.ok(h.texts.at(-1)!.includes("Яндекс не отвечает"), h.texts.at(-1));
});

test("лс: альбом по ссылке при сбое Яндекса → «Яндекс не отвечает»", async () => {
  const h = dmUploadHarness({ getAlbum: strictDown });
  await startAlbumUpload(h.bot, 10, 1, 123, h.container);
  assert.ok(h.texts.at(-1)!.includes("Яндекс не отвечает"), h.texts.at(-1));
});
