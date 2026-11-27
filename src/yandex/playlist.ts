/** Плейлисты: резолв share-ссылки, шапка, плейлист как AlbumData (методы YandexClient). */
import type { Client as LibClient } from "@dvxch/yandex-music";
import { normalizeCoverUrl } from "./media.ts";
import type { AlbumData, YaTrack } from "./types.ts";

/** withLib/withLibStrict YandexClient'а (retry + лог-фолбэк; strict бросает YandexUnavailableError). */
export interface LibRunners {
  withLib<T>(label: string, fallback: T, func: (lib: LibClient) => Promise<T>): Promise<T>;
  withLibStrict<T>(label: string, fallback: T, func: (lib: LibClient) => Promise<T>): Promise<T>;
}

/** сырой ответ usersPlaylists: треки тут — «короткие» (часто только id). */
async function fetchPlaylist(c: LibRunners, owner: string, kind: number, strict = false) {
  const run = strict ? c.withLibStrict : c.withLib;
  return run(`getPlaylist(${owner}, ${kind})`, null, async (lib) => {
    return (await lib.usersPlaylists(kind, owner)) as unknown as {
      title?: string;
      cover?: { uri?: string };
      tracks?: Array<{ id?: string | number; track?: YaTrack }>;
    } | null;
  });
}

/** ссылка «поделиться» (/playlists/<uuid>) → (owner=uid, kind) для обычного пути плейлиста.
 * uid числовой — годится и для deep-link'а, и для resume. */
export async function resolvePlaylistUuid(
  c: LibRunners,
  uuid: string,
  opts: { strict?: boolean } = {},
): Promise<{ owner: string; kind: number } | null> {
  const run = opts.strict ? c.withLibStrict : c.withLib;
  return run(`resolvePlaylistUuid(${uuid})`, null, async (lib) => {
    const pl = (await lib.playlist(uuid)) as unknown as {
      uid?: number;
      owner?: { uid?: number };
      kind?: number;
    } | null;
    const uid = pl?.owner?.uid ?? pl?.uid;
    const kind = pl?.kind;
    if (uid === undefined || kind === undefined || !Number.isFinite(kind) || kind <= 0) return null;
    return { owner: String(uid), kind };
  });
}

/** шапка плейлиста без резолва треков — для inline-результата (одним запросом). */
export async function getPlaylistShort(
  c: LibRunners,
  owner: string,
  kind: number,
  opts: { strict?: boolean } = {},
): Promise<{ title: string; coverUri: string; trackCount: number } | null> {
  const playlist = await fetchPlaylist(c, owner, kind, opts.strict);
  if (!playlist) return null;
  return {
    title: playlist.title || "",
    coverUri: playlist.cover?.uri || "",
    trackCount: playlist.tracks?.length ?? 0,
  };
}

/** плейлист как AlbumData (переиспользует всю инфру AlbumService: chunked
 *  download/send/retry/resume) — owner из URL, kind = id плейлиста внутри owner. */
/** strict — только для шапки плейлиста (лс): сбой Яндекса ≠ «плейлист не найден». */
export async function getPlaylist(
  c: LibRunners,
  owner: string,
  kind: number,
  opts: { strict?: boolean } = {},
): Promise<AlbumData | null> {
  const playlist = await fetchPlaylist(c, owner, kind, opts.strict);
  if (!playlist) return null;

  const shorts = playlist.tracks ?? [];
  const byId = new Map<string, YaTrack>();
  const idsToFetch: (string | number)[] = [];
  for (const s of shorts) {
    if (s.track) byId.set(String(s.id), s.track);
    else if (s.id !== undefined) idsToFetch.push(s.id);
  }

  if (idsToFetch.length > 0) {
    // POST с телом (не query) — id одним запросом, без постраничного чанкинга.
    // ponytail: для плейлистов в тысячи треков стоит бить на пачки, если
    // вообще станет проблемой — для личной библиотеки это не размер.
    const fetched = await c.withLib(`getPlaylist tracks(${idsToFetch.length})`, [] as YaTrack[], async (lib) => {
      return (await lib.tracks(idsToFetch)) as unknown as YaTrack[];
    });
    for (const t of fetched) if (t?.id !== undefined) byId.set(String(t.id), t);
  }

  const orderedTracks: YaTrack[] = [];
  for (const s of shorts) {
    const t = s.id !== undefined ? byId.get(String(s.id)) : undefined;
    if (t) orderedTracks.push(t);
  }

  const data = buildPlaylistAlbumData(kind, playlist.title || "", playlist.cover?.uri || "", orderedTracks);
  // owner нужен resume: по одному kind плейлист не перезапросить.
  if (data) data.playlist_owner = owner;
  return data;
}

/** треки плейлиста → AlbumData (переиспользует карточку/выгрузку альбома).
 *  Чистая функция — сеть уже отработала, тут только форма и фильтр available. */
export function buildPlaylistAlbumData(
  kind: number,
  title: string,
  coverUri: string,
  tracks: YaTrack[],
): AlbumData | null {
  const available = tracks.filter((t) => t && t.available);
  if (available.length === 0) return null;
  available.forEach((t, i) => {
    t._trackNumber = i + 1;
    t._discNumber = 1;
  });
  return {
    id: kind,
    title,
    artist: "Плейлист",
    year: "",
    label: "",
    cover_url: coverUri ? normalizeCoverUrl(coverUri, "orig") : "",
    genre: "",
    album_type: "playlist",
    tracks: available,
    volumes: [available],
  };
}
