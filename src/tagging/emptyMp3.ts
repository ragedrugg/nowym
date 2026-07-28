/** Пустой ~1с mp3 с минимальными ID3 — для пустышек в кэш-канале. */

/** ID3v2.3 текстовый фрейм с UTF-16+BOM (encoding 0x01). */
function createTextFrame(frameId: string, text: string): Buffer {
  // Node 'utf16le' не добавляет BOM — добавляем вручную
  const bom = Buffer.from([0xff, 0xfe]);
  const textEncoded = Buffer.concat([Buffer.from([0x01]), bom, Buffer.from(text, "utf16le")]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(textEncoded.length, 0);
  return Buffer.concat([Buffer.from(frameId, "latin1"), size, Buffer.from([0x00, 0x00]), textEncoded]);
}

function createId3v2Tag(artist: string, title: string, album?: string | null): Buffer {
  const frames: Buffer[] = [];
  if (artist) frames.push(createTextFrame("TPE1", artist));
  if (title) frames.push(createTextFrame("TIT2", title));
  if (album) frames.push(createTextFrame("TALB", album));
  const framesData = Buffer.concat(frames);

  const tagSize = framesData.length;
  // synchsafe size: 7 бит на байт
  const synchsafe = Buffer.from([
    (tagSize >> 21) & 0x7f,
    (tagSize >> 14) & 0x7f,
    (tagSize >> 7) & 0x7f,
    tagSize & 0x7f,
  ]);
  const header = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([0x03, 0x00, 0x00]), synchsafe]);
  return Buffer.concat([header, framesData]);
}

export function createEmptyMp3(artist: string, title: string, album?: string | null): Buffer {
  const frameHeader = Buffer.from([0xff, 0xe3, 0x18, 0xc4]);
  const frameSize = 417;
  const frameData = Buffer.alloc(frameSize - 4); // нули
  const frame = Buffer.concat([frameHeader, frameData]);
  const frames: Buffer[] = [];
  for (let i = 0; i < 38; i++) frames.push(frame);
  const mp3Data = Buffer.concat(frames);
  return Buffer.concat([createId3v2Tag(artist, title, album), mp3Data]);
}

// /get-file-info может молча отдать lossy-фолбэк в aac-семействе (M4A-контейнер) —
// без этой карты такие файлы получали .mp3 и плееры показывали случайный битрейт.
const MP4_CODECS = new Set(["flac-mp4", "aac", "he-aac", "aac-mp4", "he-aac-mp4"]);

function extFor(codec: string): string {
  if (codec === "flac") return "flac";
  if (MP4_CODECS.has(codec)) return "m4a";
  return "mp3";
}

/** имя файла. codec: mp3 → .mp3, flac → .flac, остальное (aac-семейство, в т.ч.
 * из /get-file-info) → .m4a (mp4-контейнер). */
export function getFilename(artist: string, title: string, codec = "mp3"): string {
  const a = artist || "Unknown";
  const t = title || "Unknown";
  // спецсимволы пути + управляющие (CR/LF/NUL): последние защищают от инъекции
  // в Content-Disposition multipart-формы при заливке файла.
  const invalid = /[<>:"/\\|?*\x00-\x1f]/g;
  const safeArtist = a.replace(invalid, "_");
  const safeTitle = t.replace(invalid, "_");
  return `${safeArtist} - ${safeTitle}.${extFor(codec)}`;
}
