/** Доменные типы Yandex Music.
 *
 * Структурные срезы поверхности @dvxch/yandex-music: моделируем только поля,
 * которые реально читает наш код (client.ts + metadata.ts), и на границе
 * приводим библиотечные модели к этим формам (`as unknown as YaTrack/YaAlbum`).
 * Плюс наши агрегаты AlbumData / TrackMetadata / CardMeta. */

export interface YaArtist {
  id?: number | string;
  name?: string;
}

/** Album.labels: либо [{name}], либо [string]. */
export type YaLabel = string | { name?: string };

export interface YaTrackPosition {
  volume?: number | null;
  index?: number | null;
}

/** track.derivedColors / album.derivedColors — готовые hex-цвета обложки. */
export interface YaDerivedColors {
  accent?: string | null;
  average?: string | null;
  waveText?: string | null;
  miniPlayer?: string | null;
}

/** track.metaData — fallback из embed-структуры (редко присутствует). */
export interface YaMetaData {
  album?: string | null;
  year?: string | number | null;
  number?: number | null;
  volume?: number | null;
  genre?: string | null;
  composer?: string | null;
  version?: string | null;
}

export interface YaAlbum {
  id?: number;
  title?: string | null;
  year?: number | string | null;
  genre?: string | null;
  trackCount?: number | null;
  type?: string | null;
  labels?: YaLabel[] | null;
  coverUri?: string | null;
  artists?: YaArtist[] | null;
  available?: boolean;
  trackPosition?: YaTrackPosition | null;
  derivedColors?: YaDerivedColors | null;
  /** только у albums_with_tracks: список дисков, каждый — список треков */
  volumes?: YaTrack[][] | null;
}

export interface YaTrack {
  id?: number | string;
  title?: string | null;
  available?: boolean;
  durationMs?: number | null;
  contentWarning?: string | null;
  explicit?: boolean | null;
  version?: string | null;
  artists?: YaArtist[] | null;
  albums?: YaAlbum[] | null;
  coverUri?: string | null;
  derivedColors?: YaDerivedColors | null;
  metaData?: YaMetaData | null;
  trackPosition?: YaTrackPosition | null;
  /** проставляется нами в client.getAlbum() — позиция в выгружаемом альбоме */
  _trackNumber?: number;
  _discNumber?: number;
}

/** один вариант загрузки из /tracks/{id}/download-info */
export interface DownloadInfo {
  codec: string;
  bitrateInKbps: number;
  gain?: boolean;
  preview?: boolean;
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
  id: number;
  title: string;
  artist: string;
  year: string;
  label: string;
  cover_url: string;
  genre: string;
  /** сырое album.type из API: "single" | "podcast" | "audiobook" | ... | "" */
  album_type: string;
  tracks: YaTrack[];
  volumes: YaTrack[][];
}

/** поля, возвращаемые buildCardMeta — для meta-строки карточки. */
export interface CardMeta {
  album: string;
  album_type: string;
  type_ru: string;
  year: string;
  /** все лейблы альбома (для ℗-строки на карточке). */
  labels: string[];
  genre: string;
  track_number: number | null;
  track_total: number | null;
  version: string;
  explicit: boolean;
  is_single: boolean;
  colors: CardColors;
  album_id: number | null;
  track_id: number | string | null;
  liked: boolean | null;
}

export interface CardColors {
  accent?: string;
  average?: string;
  wave_text?: string;
  /** подмешивается enrichCardMetaColor для ч/б обложек */
  wave?: string;
}
