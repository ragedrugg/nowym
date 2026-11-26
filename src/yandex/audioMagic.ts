/** Проверка контейнера скачанного аудио по магическим байтам: HTML/JSON-ошибка CDN
 * или обрезанный/битый ответ не должны попасть в теги и в кэш file_id. */

const MP4_FAMILY = new Set(["flac-mp4", "aac-mp4", "he-aac-mp4", "mp4"]);

/** Сколько первых байт достаточно для проверки. */
export const AUDIO_MAGIC_BYTES = 16;

export class AudioMagicError extends Error {
  constructor(codec: string, head: Uint8Array) {
    super(`байты не похожи на контейнер ${codec}: ${Buffer.from(head.subarray(0, 8)).toString("hex")}`);
    this.name = "AudioMagicError";
  }
}

/** true — начало данных соответствует контейнеру кодека; неизвестные кодеки не проверяем. */
export function hasAudioMagic(data: Uint8Array, codec: string | null | undefined): boolean {
  if (!codec) return true;
  if (MP4_FAMILY.has(codec)) {
    // ISO BMFF: [size:4]['ftyp'] или ['styp'] (фрагментированный mp4 начинается с styp)
    if (data.length < 8 || data[5] !== 0x74 || data[6] !== 0x79 || data[7] !== 0x70) return false;
    return data[4] === 0x66 || data[4] === 0x73;
  }
  if (codec === "flac") {
    // допускается ID3v2-префикс: 10 байт заголовка + synchsafe-размер (+10, если есть footer)
    let off = 0;
    if (data.length >= 3 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
      if (data.length < 10) return false;
      const size = (data[6]! << 21) | (data[7]! << 14) | (data[8]! << 7) | data[9]!;
      if ((data[6]! | data[7]! | data[8]! | data[9]!) & 0x80) return false; // не synchsafe
      off = 10 + size + ((data[5]! & 0x10) !== 0 ? 10 : 0);
    }
    return (
      data.length >= off + 4 &&
      data[off] === 0x66 &&
      data[off + 1] === 0x4c &&
      data[off + 2] === 0x61 &&
      data[off + 3] === 0x43
    );
  }
  if (codec === "mp3") {
    if (data.length >= 3 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) return true; // ID3
    return data.length >= 2 && data[0] === 0xff && (data[1]! & 0xe0) === 0xe0; // MPEG frame sync
  }
  return true;
}

export function assertAudioMagic(data: Uint8Array, codec: string | null | undefined): void {
  if (!hasAudioMagic(data, codec)) throw new AudioMagicError(codec ?? "?", data);
}
