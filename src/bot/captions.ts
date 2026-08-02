/** Подписи под аудио для inline-результатов. */
import { blockquote, bold, type FormattableString, format, italic, link } from "gramio";
import { trackUrl } from "../yandex/urls.ts";

export function senderHandleOf(user: { username?: string | null; firstName?: string | null }): string {
  return user.username ? `@${user.username}` : user.firstName || "user";
}

// he-aac/aac-mp4/he-aac-mp4 — то же, что отдаёт /get-file-info при недоступном
// true-lossless; сведены к тем же трём категориям, что и их «базовые» кодеки.
const FLAC_CODECS = new Set(["flac", "flac-mp4"]);
const AAC_CODECS = new Set(["aac", "he-aac", "aac-mp4", "he-aac-mp4"]);

function codecLabel(codec: string): string {
  if (FLAC_CODECS.has(codec)) return "превосходное";
  if (AAC_CODECS.has(codec)) return "экономичное";
  if (codec === "mp3") return "оптимальное";
  return codec.toUpperCase();
}

function formatCodecBitrate(codec: string | null | undefined, bitrateKbps: number | null | undefined): string {
  if (!codec) return "";
  let label = codecLabel(codec);
  if (bitrateKbps) label += ` ${bitrateKbps} кбит/с`;
  return label;
}

/** «MP3 320 кб/с — открыть» с гиперссылкой на /track/<id>. */
export function buildTrackCaption(
  trackId: string | number,
  codec: string | null | undefined,
  bitrateKbps: number | null | undefined,
  degraded = false,
): FormattableString {
  const quality = formatCodecBitrate(codec, bitrateKbps);
  const url = trackUrl(trackId);
  // degraded — запрошено превосходное (FLAC), но недоступно и отдано lossy: пометка.
  const note = degraded ? "⚠️ превосходное недоступно · " : "";
  if (!quality) return degraded ? format`${note}${link("открыть", url)}` : format`${link("открыть", url)}`;
  return format`${note}${quality} — ${link("открыть", url)}`;
}

/** делит строку на две: первая → жирный, вторая → курсив. Разделитель остаётся
 * в первой части. Режем только по «,;:» / em-dash / дефису-пайпу в окружении
 * пробелов — чтобы не рвать «чуть-чуть», «что-то» по внутреннему дефису. */
export function splitLyricsLine(line: string): [string, string] {
  const m = line.match(/[,;:]|\s—\s?|\s-\s|\s\|\s/);
  if (m && m.index !== undefined) {
    const cut = m.index + m[0].length;
    return [line.slice(0, cut).trim(), line.slice(cut).trim()];
  }
  const words = line.split(/\s+/);
  const mid = Math.max(1, Math.floor(words.length / 2));
  return [words.slice(0, mid).join(" "), words.slice(mid).join(" ")];
}

/** blockquote-цитата строки лирики: первая часть жирная, вторая курсивная. */
export function buildLyricsQuote(lyricsLine: string | null): FormattableString | null {
  if (!lyricsLine) return null;
  const [first, second] = splitLyricsLine(lyricsLine);
  if (first && second) return blockquote(format`${bold(first)} ${italic(second)}`);
  if (first) return blockquote(bold(first));
  if (second) return blockquote(italic(second));
  return null;
}
