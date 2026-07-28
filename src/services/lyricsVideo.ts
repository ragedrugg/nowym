// /** Генерация MP4-видеокарточки с синхронизированной лирикой (LRC).
//  * Работает только для треков с LRC из Яндекс.Музыки.
//  * Форматы: 16:9 (1600×900) и 9:16 (900×1600).
//  *
//  * Пайплайн кадров: canvas.data() отдаёт сырой RGBA-буфер без кодирования в
//  * JPEG, он льётся напрямую в stdin ffmpeg как rawvideo. Готовый MP4 читается
//  * из stdout — ни одного временного файла на диске, никаких лишних кодеков
//  * между рендером и финальным h264. */
// import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
// import { randomUUID } from "node:crypto";
// import { tmpdir } from "node:os";
// import path from "node:path";
// import { unlink, writeFile } from "node:fs/promises";
// import { MediaUpload } from "gramio";
// import type { Bot } from "gramio";
// import type { Container } from "../bot/container.ts";
// import { fetchUserAvatar } from "../bot/cardBuilder.ts";
// import { getLogger } from "../infra/logging.ts";
// import { renderNowPlayingCard, type CardOptions, type LyricsBlock } from "./card.ts";
// import { parseLrc, filterLrcLines } from "../yandex/lrc.ts";
// import { fetchCover, normalizeCoverUrl } from "../yandex/media.ts";
// import { buildCardMeta, enrichCardMetaColor, formatTrackBasics, metaNeedsWaveColor } from "../yandex/metadata.ts";
// import type { TgUser } from "../bot/handlers/common.ts";
// 
// const log = getLogger("services.lyricsVideo");
// 
// const _videoInFlight = new Set<number>();
// 
// const FPS = 60;
// const TRANS_MS = 667; // длительность перехода между строками
// const FFMPEG_TIMEOUT_MS = 300_000; // 5 мин — треки могут быть длинными
// const MAX_LRC_LINES = 500;
// 
// function easeInOut(t: number): number {
//   return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
// }
// 
// interface FfmpegRun {
//   proc: ChildProcessWithoutNullStreams;
//   closed: Promise<{ code: number | null; stderr: string }>;
// }
// 
// function spawnFfmpeg(args: string[]): FfmpegRun {
//   const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
//   proc.stdin.on("error", () => { /* EPIPE при раннем завершении ffmpeg — игнорируем, close сообщит об ошибке */ });
// 
//   let stderr = "";
//   proc.stderr.on("data", (d: Buffer) => {
//     if (stderr.length < 4000) stderr += d.toString();
//   });
// 
//   const closed = new Promise<{ code: number | null; stderr: string }>((resolve) => {
//     let settled = false;
//     const done = (code: number | null): void => {
//       if (settled) return;
//       settled = true;
//       clearTimeout(killer);
//       resolve({ code, stderr });
//     };
//     const killer = setTimeout(() => {
//       log.warning(`ffmpeg (лирика) таймаут ${FFMPEG_TIMEOUT_MS}ms`);
//       proc.kill("SIGKILL");
//       done(null);
//     }, FFMPEG_TIMEOUT_MS);
//     proc.on("error", (e) => {
//       log.error(`ffmpeg не запустился: ${e}`);
//       done(null);
//     });
//     proc.on("close", (code) => done(code));
//   });
// 
//   return { proc, closed };
// }
// 
// /** Пишет буфер в stdin с учётом backpressure — ждёт 'drain', если внутренний
//  * буфер потока переполнен, иначе гонка рендера с производительностью ffmpeg
//  * бесконтрольно растит память процесса.
//  *
//  * Также резолвится на 'close'/'error' потока: если ffmpeg убит (таймаут,
//  * падение), 'drain' от уже уничтоженного stdin никогда не придёт — без этого
//  * цикл записи кадров подвисает навсегда, а вызывающая функция никогда не
//  * доходит до catch/finally (пользователь не получает ни видео, ни ошибку). */
// function writeStdin(proc: ChildProcessWithoutNullStreams, buf: Buffer): Promise<void> {
//   if (proc.stdin.destroyed) return Promise.resolve();
//   if (proc.stdin.write(buf)) return Promise.resolve();
//   return new Promise((resolve) => {
//     const stdin = proc.stdin;
//     const done = (): void => {
//       stdin.off("drain", done);
//       stdin.off("close", done);
//       stdin.off("error", done);
//       resolve();
//     };
//     stdin.once("drain", done);
//     stdin.once("close", done);
//     stdin.once("error", done);
//   });
// }
// 
// interface VideoRenderArgs {
//   lrcText: string;
//   coverBytes: Buffer | null;
//   title: string;
//   artist: string;
//   progressMs: number;
//   durationMs: number;
//   senderHandle: string | null;
//   senderAvatar: Buffer | null;
//   botUsername: string | null;
//   meta: Partial<import("../yandex/types.ts").CardMeta>;
//   cardOptions: CardOptions;
//   /** локальный путь к уже скачанному аудио — ffmpeg сам сеть не трогает, чтобы
//    * не зависнуть на нестабильном CDN Яндекса (см. infra/http.ts downloadAudio). */
//   audioPath: string | null;
//   width: number;
//   height: number;
// }
// 
// async function renderLyricsVideoBuffer(args: VideoRenderArgs): Promise<Buffer> {
//   const allLines = parseLrc(args.lrcText);
//   const lines = filterLrcLines(allLines).slice(0, MAX_LRC_LINES);
//   if (lines.length === 0) throw new Error("нет строк LRC после фильтрации");
// 
//   const textLines = lines.map((l) => l.text);
//   const { width: W, height: H } = args;
// 
//   const ffArgs: string[] = [
//     "-y",
//     "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${W}x${H}`, "-r", String(FPS), "-i", "pipe:0",
//   ];
//   // аудио — уже локальный файл (скачан заранее через downloadAudio с ретраями),
//   // ffmpeg тут ничего не тянет по сети и не может зависнуть на CDN.
//   if (args.audioPath) ffArgs.push("-i", args.audioPath);
//   ffArgs.push("-map", "0:v:0");
//   if (args.audioPath) ffArgs.push("-map", "1:a:0");
//   ffArgs.push("-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p");
//   if (args.audioPath) ffArgs.push("-c:a", "aac", "-b:a", "192k", "-shortest");
//   ffArgs.push("-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1");
// 
//   const { proc, closed } = spawnFfmpeg(ffArgs);
//   const outChunks: Buffer[] = [];
//   proc.stdout.on("data", (d: Buffer) => outChunks.push(d));
// 
//   let dead = false;
//   void closed.then(() => { dead = true; });
// 
//   const renderFrame = async (activeFloat: number, progressMs: number): Promise<Buffer> => {
//     const block: LyricsBlock = {
//       lines: textLines,
//       activeIndex: Math.max(0, Math.floor(activeFloat)),
//       activeFloat,
//     };
//     return renderNowPlayingCard({
//       coverBytes: args.coverBytes,
//       title: args.title,
//       artist: args.artist,
//       progressMs,
//       durationMs: args.durationMs,
//       senderHandle: args.senderHandle,
//       senderAvatar: args.senderAvatar,
//       botUsername: args.botUsername,
//       meta: args.meta,
//       cardOptions: args.cardOptions,
//       lyrics: block,
//       rawRGBA: true,
//     }) as Promise<Buffer>;
//   };
// 
//   // hold: один рендер кадра, повторяется нужное число раз на выбранном FPS —
//   // одинаковые кадры почти ничего не стоят libx264 для кодирования.
//   const writeHold = async (activeFloat: number, progressMs: number, durMs: number): Promise<void> => {
//     if (durMs <= 0 || dead) return;
//     const buf = await renderFrame(activeFloat, progressMs);
//     const n = Math.max(1, Math.round((durMs / 1000) * FPS));
//     for (let i = 0; i < n && !dead; i++) {
//       await writeStdin(proc, buf);
//     }
//   };
// 
//   // intro: без подсветки, пока не наступила первая строка (activeFloat=-1)
//   const introMs = lines[0]!.timeMs;
//   if (introMs > 200) await writeHold(-1, 0, introMs);
// 
//   for (let i = 0; i < lines.length && !dead; i++) {
//     const line = lines[i]!;
//     const nextLine = lines[i + 1];
//     const lineDurationMs = nextLine
//       ? nextLine.timeMs - line.timeMs
//       : Math.max(2000, args.durationMs > 0 ? args.durationMs - line.timeMs : 5000);
// 
//     const isLast = i === lines.length - 1;
//     const holdMs = isLast ? lineDurationMs : Math.max(0, lineDurationMs - TRANS_MS);
//     const transMs = isLast ? 0 : Math.min(lineDurationMs, TRANS_MS);
//     const transFrames = isLast ? 0 : Math.max(1, Math.round((transMs / 1000) * FPS));
// 
//     if (holdMs > 0) await writeHold(i, line.timeMs, holdMs);
// 
//     // переход: по кадру на каждый реальный тик FPS — максимально плавно,
//     // без квантования в блоки и без последующей передискретизации ffmpeg'ом
//     // (раньше concat-демуксер пересчитывал произвольные длительности кадров
//     // в постоянный FPS и это давало рывки на стыках строк).
//     for (let j = 0; j < transFrames && !dead; j++) {
//       const tEased = easeInOut((j + 1) / transFrames);
//       const af = i + tEased;
//       const pMs = line.timeMs + (transMs * (j + 1)) / transFrames;
//       const buf = await renderFrame(af, pMs);
//       await writeStdin(proc, buf);
//     }
//   }
// 
//   proc.stdin.end();
//   const { code, stderr } = await closed;
//   if (code !== 0) throw new Error(`ffmpeg завершился с ошибкой (код ${code}): ${stderr.slice(-2000)}`);
// 
//   return Buffer.concat(outChunks);
// }
// 
// /** Генерирует и отправляет MP4-видеокарточку с лирикой текущего трека. */
// export async function buildAndSendLyricsVideo(
//   bot: Bot,
//   chatId: number,
//   user: TgUser,
//   container: Container,
// ): Promise<void> {
//   if (_videoInFlight.has(user.id)) {
//     await bot.api.sendMessage({ chat_id: chatId, text: "⏳ видеокарточка уже генерируется, подожди..." });
//     return;
//   }
//   _videoInFlight.add(user.id);
// 
//   let progressMsg: { message_id: number } | null = null;
//   try {
//     const token = await container.resolveToken(user.id);
//     if (!token) {
//       await bot.api.sendMessage({ chat_id: chatId, text: "сначала войди — /login или жми 🔐 в меню" });
//       return;
//     }
// 
//     const yandex = await container.getYandexService(token, user.id);
//     const current = await yandex.getCurrentTrack();
//     const track = current.track;
//     if (!track) {
//       await bot.api.sendMessage({ chat_id: chatId, text: "🎵 сейчас ничего не играет" });
//       return;
//     }
//     if (!track.id) {
//       await bot.api.sendMessage({ chat_id: chatId, text: "🎵 не удалось определить трек" });
//       return;
//     }
// 
//     const lrcText = await yandex.getTrackLRC(track.id);
//     if (!lrcText) {
//       await bot.api.sendMessage({ chat_id: chatId, text: "у этого трека нет синхронизированных текстов 🎶" });
//       return;
//     }
// 
//     progressMsg = await bot.api.sendMessage({ chat_id: chatId, text: "⏳ генерирую видеокарточку..." });
// 
//     const [artist, title] = formatTrackBasics(track, "");
//     const senderHandle = user.username ? `@${user.username}` : user.firstName || "user";
//     const settings = await container.getUserSettings(user.id);
//     const meta = buildCardMeta(track);
//     const coverUrl = normalizeCoverUrl(track.coverUri ?? "", "1000x1000");
// 
//     // видео только 16:9 / 9:16 — другие аспекты фолбэк к 16:9
//     const aspect = settings.card_aspect === "9:16" ? "9:16" : "16:9";
//     const [w, h] = aspect === "9:16" ? [900, 1600] : [1600, 900];
// 
//     if (metaNeedsWaveColor(meta)) {
//       try {
//         await enrichCardMetaColor(meta, yandex);
//       } catch {
//         /* best-effort */
//       }
//     }
// 
//     const [coverBytes, senderAvatar, audioUrl] = await Promise.all([
//       coverUrl ? fetchCover(coverUrl, container.httpClient) : Promise.resolve(null),
//       settings.card_toggles.avatar ? fetchUserAvatar(bot, user.id, container) : Promise.resolve(null),
//       yandex.getDownloadUrl(track, "best").catch(() => null),
//     ]);
// 
//     // аудио качаем сами через downloadAudio (ретраи + короткие таймауты) и
//     // отдаём ffmpeg локальный файл — CDN Яндекса иногда виснет на прямых
//     // ссылках, а прямая передача URL в ffmpeg вешала весь процесс на минуты.
//     let audioPath: string | null = null;
//     if (audioUrl) {
//       try {
//         const audioBytes = await container.httpClient.downloadAudio(audioUrl);
//         audioPath = path.join(tmpdir(), `lyrics-video-audio-${randomUUID()}.mp3`);
//         await writeFile(audioPath, audioBytes);
//       } catch (e) {
//         log.warning(`[lyrics-video] аудио не скачано, видео без звука: ${e}`);
//         audioPath = null;
//       }
//     }
// 
//     try {
//       const videoBytes = await renderLyricsVideoBuffer({
//         lrcText,
//         coverBytes,
//         title,
//         artist,
//         progressMs: current.progress_ms ?? 0,
//         durationMs: current.duration_ms ?? 0,
//         senderHandle,
//         senderAvatar,
//         botUsername: container.botUsername,
//         meta,
//         cardOptions: {
//           toggles: settings.card_toggles,
//           progress: settings.card_progress,
//           aspect,
//         },
//         audioPath,
//         width: w,
//         height: h,
//       });
// 
//       await bot.api.sendVideo({
//         chat_id: chatId,
//         video: MediaUpload.buffer(videoBytes, "lyrics.mp4"),
//         width: w,
//         height: h,
//         supports_streaming: true,
//       });
//       log.info(`[lyrics-video] отправлено user=${user.id} ${title}`);
//     } finally {
//       if (audioPath) await unlink(audioPath).catch(() => {});
//     }
//   } catch (e) {
//     log.error(`[lyrics-video] ошибка user=${user.id}: ${e}`);
//     await bot.api.sendMessage({ chat_id: chatId, text: "❌ не получилось сгенерировать видеокарточку" }).catch(() => {});
//   } finally {
//     _videoInFlight.delete(user.id);
//     if (progressMsg) {
//       await bot.api.deleteMessage({ chat_id: chatId, message_id: progressMsg.message_id }).catch(() => {});
//     }
//   }
// }
