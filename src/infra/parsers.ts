/** парсинг inline-запросов: текст, ссылка на трек или ссылка на альбом. */

const TRACK_URL_RE =
  /(?:music\.yandex(?:\.ru)?\/album\/\d+\/track|yandex\.ru\/music\/album\/\d+\/track)\/(\d+)/;

// альбомный URL — без /track. (?!\d) не даёт \d+ бэктрекнуться на цифру короче
// (иначе на .../album/123456/tracks lookahead после отката пропускал бы "12345").
const ALBUM_URL_RE =
  /(?:music\.yandex(?:\.ru)?\/album|yandex\.ru\/music\/album)\/(\d+)(?!\d)(?!\/track\/\d)/;

export type ParsedQuery =
  | { type: "empty" }
  | { type: "track_link"; track_id: number }
  | { type: "album_link"; album_id: number }
  | { type: "search"; content: string };

function extractId(query: string, re: RegExp): number | null {
  const m = re.exec(query);
  if (!m || m[1] === undefined) return null;
  const id = parseInt(m[1], 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export function parseSearchQuery(query: string): ParsedQuery {
  if (!query || !query.trim()) return { type: "empty" };

  const q = query.trim();
  const trackId = extractId(q, TRACK_URL_RE);
  if (trackId) return { type: "track_link", track_id: trackId };

  const albumId = extractId(q, ALBUM_URL_RE);
  if (albumId) return { type: "album_link", album_id: albumId };

  return { type: "search", content: q };
}
