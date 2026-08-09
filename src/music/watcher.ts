/** «Сейчас играет» через периодический запрос к Spotify Web API.
 *
 * Заменяет YnisonService из Яндекса. Spotify не даёт ws-плеера, поэтому только
 * polling: /me/player/currently-playing, каждые ~3с пока играет, ~15с пока
 * пусто/пауза. Прогресс между запросами интерполируется по времени. */

import type { Track } from "./types.ts";

/** результат getCurrentTrack — трек + статус воспроизведения. */
export interface CurrentTrack {
  track: Track | null;
  paused: boolean;
  duration_ms: number;
  progress_ms: number;
  entity_id: string | null;
  entity_type: string | null;
}

/** живой прогресс с учётом времени, прошедшего с момента снапшота. */
export function liveProgressMs(
  progressMs: number,
  durationMs: number,
  paused: boolean,
  timestampMs: number,
  playbackSpeed = 1.0,
): number {
  if (paused || !timestampMs) return Math.max(0, progressMs);
  const elapsed = (Date.now() - timestampMs) * playbackSpeed;
  const progress = progressMs + elapsed;
  return Math.max(0, Math.min(progress, durationMs || progress));
}
