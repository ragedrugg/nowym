/** yt-dlp резолвер: (artist + title / ISRC) → локальный аудиофайл.
 *
 * Стратегия матчинга:
 *   1. Если есть ISRC — ytsearch:"<ISRC>", доверяем результату (Topic-каналы
 *      артистов почти всегда несут ISRC в описании).
 *   2. Иначе — ytsearch:"<artist> <title>" с фильтром по длительности ±3 сек
 *      от заявленной, чтобы не подтянуть кавер/live/remix.
 *   3. Fallback — SoundCloud поиск.
 *
 * Битрейт и кодек берём с yt-dlp (обычно opus 128-160 kbps c YouTube). Файл
 * сохраняется в temp-директорию процесса; фоновый sweeper удаляет старые. */

import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLogger } from "../infra/logging.ts";

const log = getLogger("audio.ytdlp");

const TMP_ROOT = join(tmpdir(), "nowspot-audio");
const FILE_TTL_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const YTDLP_TIMEOUT_MS = 5 * 60 * 1000;
// Максимальная разница между заявленной длительностью и найденной, если
// матчим по названию — reject кавер/live/расширенный ремикс.
const DURATION_TOLERANCE_S = 3;

export interface ResolveInput {
  /** для лога/дедупа. Обычно spotify track id. */
  id: string;
  artist: string;
  title: string;
  /** секунды. Используется для фильтрации по длительности. */
  durationSec?: number | null;
  isrc?: string | null;
  quality?: "best" | "economy";
}

export interface ResolvedAudio {
  filePath: string;
  /** реальный кодек файла на диске — opus/mp3/m4a. */
  codec: string;
  bitrateKbps: number;
  /** секунды по данным yt-dlp. */
  durationSec: number;
  /** youtube / soundcloud — что оказалось источником. */
  source: "youtube" | "soundcloud";
}

interface YtdlpInfo {
  id: string;
  title?: string;
  duration?: number;
  ext?: string;
  acodec?: string;
  abr?: number;
  tbr?: number;
  webpage_url?: string;
  extractor?: string;
  filepath?: string;
  _filename?: string;
  requested_downloads?: Array<{ filepath?: string; ext?: string }>;
}

let sweeperStarted = false;

function startSweeper(): void {
  if (sweeperStarted) return;
  sweeperStarted = true;
  const timer = setInterval(() => {
    void sweepOldFiles().catch((e) => log.warning(`sweeper: ${e}`));
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}

async function sweepOldFiles(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(TMP_ROOT);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    const full = join(TMP_ROOT, name);
    try {
      const s = await stat(full);
      if (now - s.mtimeMs > FILE_TTL_MS) {
        await rm(full, { force: true });
      }
    } catch {
      // race с параллельной чисткой — игнор
    }
  }
}

async function ensureTmpRoot(): Promise<void> {
  await mkdir(TMP_ROOT, { recursive: true });
  startSweeper();
}

interface RunOpts {
  args: string[];
  timeoutMs?: number;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runYtdlp(opts: RunOpts): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", opts.args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`yt-dlp таймаут (${opts.timeoutMs ?? YTDLP_TIMEOUT_MS}мс)`));
    }, opts.timeoutMs ?? YTDLP_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

function parseInfoJson(stdout: string): YtdlpInfo | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // --print single-line JSON: одна строка, но на всякий случай берём первую
  const line = trimmed.split(/\r?\n/)[0]!;
  try {
    return JSON.parse(line);
  } catch (e) {
    log.warning(`не распарсил JSON yt-dlp: ${e}`);
    return null;
  }
}

/** Резолвит источник по запросу, без скачивания. Возвращает URL страницы. */
async function resolveSource(input: ResolveInput): Promise<{ url: string; source: "youtube" | "soundcloud" } | null> {
  const queries: Array<{ q: string; source: "youtube" | "soundcloud" }> = [];
  if (input.isrc) {
    queries.push({ q: `ytsearch1:"${input.isrc}"`, source: "youtube" });
  }
  const nameQuery = `${input.artist} ${input.title}`.replace(/["']/g, "").trim();
  queries.push({ q: `ytsearch3:${nameQuery}`, source: "youtube" });
  queries.push({ q: `scsearch3:${nameQuery}`, source: "soundcloud" });

  for (const { q, source } of queries) {
    try {
      const res = await runYtdlp({
        args: [
          "--quiet",
          "--no-warnings",
          "--flat-playlist",
          "--print",
          "%(.{id,title,duration,webpage_url,extractor})#j",
          "--playlist-end",
          "3",
          q,
        ],
        timeoutMs: 30_000,
      });
      if (res.code !== 0) {
        log.debug(`yt-dlp probe (${source}) exit=${res.code}: ${res.stderr.slice(0, 200)}`);
        continue;
      }
      const candidates = res.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as YtdlpInfo;
          } catch {
            return null;
          }
        })
        .filter((c): c is YtdlpInfo => c !== null && Boolean(c.webpage_url));

      if (candidates.length === 0) continue;

      // ISRC-запрос доверяем сразу: первый кандидат.
      if (input.isrc && source === "youtube") {
        return { url: candidates[0]!.webpage_url!, source };
      }

      // Матчинг по длительности при наличии durationSec.
      if (input.durationSec && input.durationSec > 0) {
        const match = candidates.find(
          (c) => c.duration && Math.abs(c.duration - input.durationSec!) <= DURATION_TOLERANCE_S,
        );
        if (match) return { url: match.webpage_url!, source };
      }

      // Иначе — первый кандидат.
      return { url: candidates[0]!.webpage_url!, source };
    } catch (e) {
      log.warning(`yt-dlp probe (${source}) упал: ${e}`);
    }
  }
  return null;
}

/** Скачивает найденный трек в TMP_ROOT. Возвращает описание файла. */
export async function resolveAndDownload(input: ResolveInput): Promise<ResolvedAudio | null> {
  await ensureTmpRoot();
  const src = await resolveSource(input);
  if (!src) {
    log.warning(`[ytdlp] не нашлось источника для ${input.artist} — ${input.title} (id=${input.id})`);
    return null;
  }

  // формат — bestaudio для best; для economy берём худшую (>=64kbps),
  // отталкиваясь от того, что даёт YouTube (обычно opus 48/128/160).
  const format = input.quality === "economy" ? "worstaudio[abr>=64]/worstaudio" : "bestaudio/best";
  const outputTpl = join(TMP_ROOT, `${input.id}-%(id)s.%(ext)s`);

  try {
    const res = await runYtdlp({
      args: [
        "--quiet",
        "--no-warnings",
        "--no-playlist",
        "--format",
        format,
        "--output",
        outputTpl,
        "--print",
        "after_move:%(.{id,title,duration,ext,acodec,abr,tbr,filepath,_filename,requested_downloads})#j",
        src.url,
      ],
    });
    if (res.code !== 0) {
      log.warning(`[ytdlp] download exit=${res.code}: ${res.stderr.slice(0, 300)}`);
      return null;
    }
    const info = parseInfoJson(res.stdout);
    if (!info) return null;
    const filePath = info.requested_downloads?.[0]?.filepath ?? info.filepath ?? info._filename ?? null;
    if (!filePath) {
      log.warning(`[ytdlp] нет пути к файлу в stdout: ${res.stdout.slice(0, 200)}`);
      return null;
    }
    // проверяем что файл реально на диске
    try {
      await stat(filePath);
    } catch {
      log.warning(`[ytdlp] файл не найден на диске: ${filePath}`);
      return null;
    }
    return {
      filePath,
      codec: info.acodec ?? info.ext ?? "opus",
      bitrateKbps: Math.round(info.abr ?? info.tbr ?? 160),
      durationSec: Math.round(info.duration ?? 0),
      source: src.source,
    };
  } catch (e) {
    log.warning(`[ytdlp] сбой скачивания: ${e}`);
    return null;
  }
}

/** Явная очистка одного файла (после успешной заливки в канал). */
export async function removeTempFile(filePath: string): Promise<void> {
  if (!filePath.startsWith(TMP_ROOT)) return; // защита: не даём удалить что попало
  await rm(filePath, { force: true }).catch(() => {});
}
