/** Метаданные в аудио: TagLib (WASM) — основной путь (теги + обложка, аудио не
 * трогается), ffmpeg — только для transform (nightcore/speed/slow, реальный DSP,
 * TagLib этого не умеет).
 *
 * TagLib переписывает только метаданные-чанки буфера в памяти; ffmpeg даже с
 * `-c copy` гоняет полный demux/remux через временные файлы (~55мс/файл против
 * ~1мс/файл у TagLib).
 *
 * Пишет ID3v2.4 (TagLib не даёт выбрать версию); track_total для mp3/mp4 не
 * комбинируется в «N/M» — ограничение PropertyMap в используемой версии библиотеки
 * (для FLAC/Vorbis TRACKTOTAL пишется корректно отдельным тегом).
 *
 * На любую ошибку — исходник без тегов. */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TagLib, type AudioFile } from "taglib-wasm";
import { getLogger } from "../infra/logging.ts";
import type { TrackMetadata } from "../yandex/types.ts";

const log = getLogger("tagging");

const ENCODED_BY = "@nowymbot";

// потолок на ffmpeg (только transform-путь): без него зависший процесс = вечный await + зомби
const FFMPEG_TIMEOUT_MS = 120_000;

/** codec → расширение temp-файла на входе ffmpeg (ffmpeg выбирает демуксер по нему).
 * Карта шире текущих кодеков (mp3/aac) — задел под lossless+transform. */
const CODEC_EXT: Record<string, string> = {
  mp3: "mp3",
  flac: "flac",
  aac: "m4a",
  "he-aac": "m4a",
  "aac-mp4": "m4a",
  "he-aac-mp4": "m4a",
  "flac-mp4": "m4a",
};

/** '5/12' или просто '5'. null если нет номера. */
function slashFmt(num: number | null | undefined, total: number | null | undefined): string | null {
  if (num === null || num === undefined) return null;
  return total ? `${num}/${total}` : String(num);
}

/** перекодировка аудио с -af фильтром (nightcore/speed/slow). Выход всегда mp3 320k —
 * фильтр (asetrate/atempo) требует ресэмпла, `-c copy` тут невозможен. */
export interface AudioTransform {
  /** ffmpeg `-af` цепочка фильтров. */
  filter: string;
}

export class TaggingService {
  private taglibPromise: ReturnType<typeof TagLib.initialize> | null = null;

  private getTaglib(): ReturnType<typeof TagLib.initialize> {
    if (this.taglibPromise === null) this.taglibPromise = TagLib.initialize();
    return this.taglibPromise;
  }

  /** На ошибку — исходник без тегов. transform != null → перекодировка через
   * ffmpeg-фильтр (выход mp3); иначе TagLib, аудио-поток не трогается. */
  async addMetadata(
    audioData: Buffer,
    metadata: TrackMetadata,
    codec = "mp3",
    transform?: AudioTransform,
  ): Promise<Buffer> {
    if (transform) return this.addMetadataViaFfmpeg(audioData, metadata, codec, transform);
    return this.addMetadataViaTaglib(audioData, metadata, codec);
  }

  /** быстрый путь: TagLib читает/пишет только метаданные-чанки контейнера. */
  private async addMetadataViaTaglib(audioData: Buffer, metadata: TrackMetadata, codec: string): Promise<Buffer> {
    let file: AudioFile | null = null;
    try {
      const taglib = await this.getTaglib();
      file = await taglib.open(audioData);
      const tag = file.tag();
      if (metadata.title) tag.setTitle(metadata.title);
      if (metadata.artist) tag.setArtist(metadata.artist);
      if (metadata.album) tag.setAlbum(metadata.album);
      if (metadata.genre) tag.setGenre(metadata.genre);

      const year = Number.parseInt(String(metadata.year ?? ""), 10);
      const hasYear = Number.isFinite(year) && year > 0;
      if (hasYear) tag.setYear(year);
      if (metadata.track_number) tag.setTrack(metadata.track_number);

      // generic-ключи через PropertyMap — TagLib сам раскладывает их по нужным тегам контейнера.
      const props = file.properties();
      const albumArtist = metadata.album_artist || metadata.artist;
      if (albumArtist) props.ALBUMARTIST = [albumArtist];
      if (metadata.composer) props.COMPOSER = [metadata.composer];
      if (metadata.version) props.SUBTITLE = [metadata.version];
      if (metadata.label) {
        props.PUBLISHER = [metadata.label];
        props.COPYRIGHT = [hasYear ? `© ${year} ${metadata.label}` : `© ${metadata.label}`];
      }
      if (metadata.track_total) props.TRACKTOTAL = [String(metadata.track_total)];
      if (metadata.disc_number) props.DISCNUMBER = [String(metadata.disc_number)];
      if (metadata.disc_total) props.DISCTOTAL = [String(metadata.disc_total)];
      props.ENCODEDBY = [ENCODED_BY];
      file.setProperties(props);

      if (metadata.cover_data) {
        file.setPictures([{ mimeType: "image/jpeg", data: metadata.cover_data, type: "FrontCover" }]);
      }

      if (!file.save()) return audioData;
      return Buffer.from(file.getFileBuffer());
    } catch (e) {
      log.error(`ошибка записи тегов через taglib (${codec}): ${e}`);
      return audioData;
    } finally {
      file?.dispose();
    }
  }

  /** Путь через ffmpeg — только когда нужен реальный DSP (transform). */
  private async addMetadataViaFfmpeg(
    audioData: Buffer,
    metadata: TrackMetadata,
    codec: string,
    transform: AudioTransform,
  ): Promise<Buffer> {
    const inExt = Object.hasOwn(CODEC_EXT, codec) ? CODEC_EXT[codec] : "mp3";
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), "nowym-tag-"));
      const inPath = join(dir, `in.${inExt}`);
      const outPath = join(dir, "out.mp3");
      await writeFile(inPath, audioData);

      const args = ["-loglevel", "error", "-nostdin", "-y", "-i", inPath];

      const hasCover = Boolean(metadata.cover_data);
      if (hasCover) {
        const coverPath = join(dir, "cover.jpg");
        await writeFile(coverPath, metadata.cover_data!);
        args.push("-i", coverPath);
      }

      // перекодируем аудио через фильтр; обложку копируем как attached_pic.
      args.push("-map", "0:a", "-af", transform.filter, "-c:a", "libmp3lame", "-b:a", "320k");
      if (hasCover) args.push("-map", "1:v", "-c:v", "copy", "-disposition:v:0", "attached_pic");
      args.push("-id3v2_version", "3");

      for (const [k, v] of this.metaPairs(metadata)) args.push("-metadata", `${k}=${v}`);
      args.push(outPath);

      // таймаут от длительности — транскод фильтром идёт ~по duration, не по размеру
      const timeoutMs = Math.max(FFMPEG_TIMEOUT_MS, Math.round((metadata.duration || 0) / 6) * 1000);
      const ok = await this.runFfmpeg(args, timeoutMs);
      if (!ok) return audioData;
      return await readFile(outPath);
    } catch (e) {
      log.error(`ошибка записи тегов (${codec}, transform): ${e}`);
      return audioData;
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** generic-ключи метаданных для `-metadata k=v` (ffmpeg сам разложит по тегам).
   * Только для transform-пути (addMetadataViaTaglib использует PropertyMap напрямую). */
  private *metaPairs(m: TrackMetadata): Generator<[string, string]> {
    if (m.title) yield ["title", m.title];
    if (m.artist) yield ["artist", m.artist];
    const albumArtist = m.album_artist || m.artist;
    if (albumArtist) yield ["album_artist", albumArtist];
    if (m.album) yield ["album", m.album];

    const year = Number.parseInt(String(m.year ?? ""), 10);
    const hasYear = Number.isFinite(year) && year > 0;
    if (hasYear) yield ["date", String(year)];

    if (m.label) {
      yield ["publisher", m.label];
      yield ["copyright", hasYear ? `© ${year} ${m.label}` : `© ${m.label}`];
    }
    if (m.genre) yield ["genre", m.genre];
    if (m.composer) yield ["composer", m.composer];
    if (m.version) yield ["version", m.version];

    const trck = slashFmt(m.track_number, m.track_total);
    if (trck) yield ["track", trck];
    const disc = slashFmt(m.disc_number, m.disc_total);
    if (disc) yield ["disc", disc];

    yield ["encoded_by", ENCODED_BY];
  }

  /** запускает ffmpeg, true при коде 0. Никогда не бросает. */
  private runFfmpeg(args: string[], timeoutMs = FFMPEG_TIMEOUT_MS): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      let settled = false;
      const done = (v: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        resolve(v);
      };
      const killer = setTimeout(() => {
        log.warning(`ffmpeg таймаут ${timeoutMs}ms — убиваю процесс`);
        proc.kill("SIGKILL");
        done(false);
      }, timeoutMs);
      proc.stderr.on("data", (d: Buffer) => {
        if (err.length < 2000) err += d.toString();
      });
      proc.on("error", (e) => {
        log.error(`ffmpeg не запустился: ${e}`);
        done(false);
      });
      proc.on("close", (code) => {
        if (code !== 0) {
          log.warning(`ffmpeg код ${code}: ${err.trim()}`);
          done(false);
        } else {
          done(true);
        }
      });
    });
  }
}
