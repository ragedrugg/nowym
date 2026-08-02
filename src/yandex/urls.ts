/** Публичные ссылки веб-плеера Я.Музыки — единый источник. */
const BASE = "https://music.yandex";

export const trackUrl = (id: string | number): string => `${BASE}/track/${id}`;
export const albumUrl = (id: string | number): string => `${BASE}/album/${id}`;
export const playlistUrl = (owner: string, kind: number): string => `${BASE}/users/${owner}/playlists/${kind}`;
