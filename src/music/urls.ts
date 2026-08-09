/** Публичные ссылки Spotify — единый источник. */
const BASE = "https://open.spotify.com";

export const trackUrl = (id: string | number): string => `${BASE}/track/${id}`;
export const albumUrl = (id: string | number): string => `${BASE}/album/${id}`;
/** Плейлисты в Spotify не имеют «owner»-сегмента в URL — просто playlist/<id>. */
export const playlistUrl = (_owner: string, id: string | number): string => `${BASE}/playlist/${id}`;
