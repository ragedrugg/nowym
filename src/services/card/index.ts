/** Горизонтальная карточка «сейчас играет» (ambient), на @napi-rs/canvas.
 *
 * Компоновка: размытая обложка фоном + затемнение → слева скруглённая обложка
 * с тенью → справа артист, тайтл, Material 3 wavy progress, таймкоды → внизу
 * «от/через». Skia даёт нативный AA, поэтому рисуем волну/маски напрямую
 * с round-caps, без супер-сэмплинга.
 *
 * Стили прогресса: wavy / bar. */

export { drawBackground } from "./draw.ts";
export type { LyricsBlock, RenderCardArgs } from "./layout.ts";
export { renderNowPlayingCard } from "./render.ts";
export { cleanTrackTitle, composeTitleWithVersion, fmtMmss } from "./text.ts";
