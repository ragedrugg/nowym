/** парсинг inline-запросов: текст, ссылка на трек или ссылка на альбом. */

// хост веб-плеера: music.yandex[.ru|.com|.by|.kz|.uz] (голый music.yandex ставит наш urls.ts) или yandex.<tld>/music
const HOST = String.raw`(?:music\.yandex(?:\.(?:ru|com|by|kz|uz))?|yandex\.(?:ru|com|by|kz|uz)/music)`;

// трек: и /album/N/track/M, и короткий /track/M (его бот сам ставит в кнопки)
const TRACK_URL_RE = new RegExp(String.raw`${HOST}/(?:album/\d+/)?track/(\d+)`);

// альбомный URL — без /track. (?!\d) не даёт \d+ бэктрекнуться на цифру короче
// (иначе на .../album/123456/tracks lookahead после отката пропускал бы "12345").
const ALBUM_URL_RE = new RegExp(String.raw`${HOST}/album/(\d+)(?!\d)(?!/track/\d)`);

// owner — логин/uid Яндекса, реальный чарсет [A-Za-z0-9._-]; более широкий
// класс ([^/\s]+) пропускал бы ?/#/пробелоподобное внутрь URL, который
// собирается конкатенацией в lib.usersPlaylists() (client.ts.getPlaylist).
const OWNER = String.raw`[\w.-]+`;
export const PLAYLIST_URL_RE = new RegExp(String.raw`${HOST}/users/(${OWNER})/playlists/(\d+)`);

/** owner, пригодный для deep-link payload'а (телеграм пускает только [A-Za-z0-9_-]);
 * у логина с точкой deep-link'а нет — ссылку кидают в личку (START_PLAYLIST_RE в common.ts). */
export const DEEPLINK_OWNER_RE = /^[\w-]+$/;

// новый формат «поделиться»: /playlists/<uuid> или /playlists/lk.<uuid> (без /users/<owner>/)
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const PLAYLIST_UUID_URL_RE = new RegExp(String.raw`${HOST}/playlists/((?:lk\.)?${UUID})(?![\w-])`, "i");

export type ParsedQuery =
  | { type: "empty" }
  | { type: "track_link"; track_id: number }
  | { type: "album_link"; album_id: number }
  | { type: "playlist_link"; owner: string; kind: number }
  | { type: "playlist_uuid_link"; uuid: string }
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

  const pl = PLAYLIST_URL_RE.exec(q);
  if (pl) {
    const kind = parseInt(pl[2]!, 10);
    if (Number.isFinite(kind) && kind > 0) return { type: "playlist_link", owner: pl[1]!, kind };
  }

  const plu = PLAYLIST_UUID_URL_RE.exec(q);
  if (plu) return { type: "playlist_uuid_link", uuid: plu[1]!.toLowerCase() };

  return { type: "search", content: q };
}
