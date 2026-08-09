/** парсинг inline-запросов: текст, ссылка на трек, альбом или плейлист Spotify. */

// Spotify id — 22 base62-символа. Принимаем как open.spotify.com/track/<id>, так
// и spotify:track:<id> (schemeless URI).
const TRACK_URL_RE = /(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/|spotify:track:)([A-Za-z0-9]{22})/;
const ALBUM_URL_RE = /(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?album\/|spotify:album:)([A-Za-z0-9]{22})/;
/** плейлист: open.spotify.com/playlist/<id> — owner в URL нет (Spotify перенёс
 *  его в API), но интерфейс parsedQuery остаётся с owner для совместимости. */
export const PLAYLIST_URL_RE = /(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?playlist\/|spotify:playlist:)([A-Za-z0-9]{22})/;

export type ParsedQuery =
  | { type: "empty" }
  | { type: "track_link"; track_id: string }
  | { type: "album_link"; album_id: string }
  | { type: "playlist_link"; owner: string; kind: string }
  | { type: "search"; content: string };

function extractId(query: string, re: RegExp): string | null {
  const m = re.exec(query);
  return m?.[1] ?? null;
}

export function parseSearchQuery(query: string): ParsedQuery {
  if (!query || !query.trim()) return { type: "empty" };

  const q = query.trim();
  const trackId = extractId(q, TRACK_URL_RE);
  if (trackId) return { type: "track_link", track_id: trackId };

  const albumId = extractId(q, ALBUM_URL_RE);
  if (albumId) return { type: "album_link", album_id: albumId };

  const pl = PLAYLIST_URL_RE.exec(q);
  if (pl) return { type: "playlist_link", owner: "", kind: pl[1]! };

  return { type: "search", content: q };
}
