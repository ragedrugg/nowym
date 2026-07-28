export interface CachedTrack {
  track_id: string;
  telegram_file_id: string;
  telegram_message_id: number | null;
  is_cached: boolean;
  has_metadata: boolean;
  artist: string | null;
  title: string | null;
  album: string | null;
  cover_url: string | null;
  duration: number | null;
  year: string | null;
  label: string | null;
  genre: string | null;
  codec: string | null;
  bitrate_kbps: number | null;
}

export interface TrackCacheResult {
  telegram_file_id: string;
  is_cached: boolean;
  filename: string;
}

export interface InflightAlbum {
  id: number;
  user_id: number;
  chat_id: number;
  album_id: number;
  progress_message_id: number | null;
  completed_track_ids: number[];
}
