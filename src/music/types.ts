/** Доменные типы «музыкального источника» — Spotify + yt-dlp.
 *
 * Историческая справка: бот форкнут с nowym (Яндекс.Музыка), поэтому имена
 * многих полей похожи на структуру ya.music. Внутри — маппинг ответа Spotify
 * Web API в удобные для карточки/тегов агрегаты.
 *
 * id-ы в этом слое — всегда `string` (Spotify id, 22 base62-символа), но в
 * подписях типов оставлено `number | string` для совместимости с TG file_id и
 * составными id-ами тегов эффектов ("<id>:ncore"). */

export interface Artist {
  id?: string;
  name?: string;
}

/** Label — оставлено как union: раньше пришло из яндекс-структуры, теперь тут
 *  всегда string (Spotify отдаёт copyrights[].text одной строкой). */
export type Label = string | { name?: string };

export interface TrackPosition {
  volume?: number | null;
  index?: number | null;
}

/** Готовые hex-цвета обложки. Spotify этого не отдаёт — оставлено как расширение
 *  на случай добавления собственного экстрактора цветов. */
export interface DerivedColors {
  accent?: string | null;
  average?: string | null;
  waveText?: string | null;
  miniPlayer?: string | null;
}

/** Fallback метаданные из embed-структуры. Заполняется скупо — Spotify не даёт
 *  композитора/жанра на уровне трека. */
export interface TrackMetaEmbed {
  album?: string | null;
  year?: string | number | null;
  number?: number | null;
  volume?: number | null;
  genre?: string | null;
  composer?: string | null;
  version?: string | null;
}

export interface Album {
  id?: string;
  title?: string | null;
  year?: number | string | null;
  genre?: string | null;
  trackCount?: number | null;
  /** "album" | "single" | "compilation" | "" */
  type?: string | null;
  labels?: Label[] | null;
  coverUri?: string | null;
  artists?: Artist[] | null;
  available?: boolean;
  trackPosition?: TrackPosition | null;
  derivedColors?: DerivedColors | null;
  /** только у альбома-с-треками: диски → треки */
  volumes?: Track[][] | null;
}

export interface Track {
  id?: string;
  title?: string | null;
  available?: boolean;
  durationMs?: number | null;
  /** Spotify: contentRating === "explicit". */
  contentWarning?: string | null;
  explicit?: boolean | null;
  version?: string | null;
  artists?: Artist[] | null;
  albums?: Album[] | null;
  coverUri?: string | null;
  derivedColors?: DerivedColors | null;
  metaData?: TrackMetaEmbed | null;
  trackPosition?: TrackPosition | null;
  /** ISRC — критичен для точного матчинга через yt-dlp. */
  isrc?: string | null;
  /** проставляется в client.getAlbum() — позиция в выгружаемом альбоме */
  _trackNumber?: number;
  _discNumber?: number;
}

/** один вариант загрузки. Для Spotify — всегда единственный, ISRC-подсказка для yt-dlp. */
export interface DownloadInfo {
  codec: string;
  bitrateInKbps: number;
  gain?: boolean;
  preview?: boolean;
  /** Не URL, а трек-id: yt-dlp резолвер сам находит источник по метаданным. */
  downloadInfoUrl: string;
  direct?: boolean;
}

// ── наши агрегаты ──────────────────────────────────────────────────────────

export interface TrackMetadata {
  artist: string;
  album_artist: string;
  title: string;
  album: string;
  year: string;
  label: string;
  genre: string | null;
  composer: string | null;
  version: string | null;
  explicit: boolean;
  duration: number; // секунды
  track_number: number | null;
  track_total: number | null;
  disc_number: number | null;
  disc_total: number | null;
  cover_url: string;
  cover_data: Buffer | null;
}

export interface AlbumData {
  id: string;
  title: string;
  artist: string;
  year: string;
  label: string;
  cover_url: string;
  genre: string;
  /** сырое album.type: "album" | "single" | "compilation" | "playlist" */
  album_type: string;
  tracks: Track[];
  volumes: Track[][];
}

/** поля для meta-строки карточки. */
export interface CardMeta {
  album: string;
  album_type: string;
  type_ru: string;
  year: string;
  labels: string[];
  genre: string;
  track_number: number | null;
  track_total: number | null;
  version: string;
  explicit: boolean;
  is_single: boolean;
  colors: CardColors;
  album_id: string | null;
  track_id: string | null;
  liked: boolean | null;
}

export interface CardColors {
  accent?: string;
  average?: string;
  wave_text?: string;
  wave?: string;
}
