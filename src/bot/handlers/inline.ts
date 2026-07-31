import { format } from "gramio";
import type { Bot } from "gramio";
import type { Container } from "../container.ts";
import { buildLyricsQuote, buildTrackCaption } from "../captions.ts";
import { progressMarkup, retryMarkup, trackMarkup } from "../markup.ts";
import { getLogger } from "../../infra/logging.ts";
import { createInterruptibleSleep, withTimeout } from "../../infra/async.ts";
import { parseSearchQuery } from "../../infra/parsers.ts";
import { getSettings } from "../../settings.ts";
import { cbData } from "../ctxutil.ts";
import { say, safeAnswerCb, safeEditMedia, safeSetReplyMarkup } from "../safeApi.ts";
import {
  buildLyricsCardResult,
  buildNowPlayingCardResult,
  isCardResultId,
  renderAndSwapCard,
} from "./inlineCard.ts";
import type { InlineResult, SearchService } from "../../services/search.ts";
import { type YandexClient, makeEncrawDecrypt } from "../../yandex/client.ts";
import type { CachedTrack } from "../../storage/types.ts";
import type { YaTrack } from "../../yandex/types.ts";
import {
  type AudioQuality,
  buildTrackMetadata,
  enrichMetadataFromAlbum,
  findBestLyricsLine,
  formatDurationHuman,
  formatTrackBasics,
  trackIsTooLong,
} from "../../yandex/metadata.ts";

const log = getLogger("bot.inline");

const RECENT_RE = /^(недавн(ее|ие)|recent|истори[яю])$/i;

// ── аудио-эффекты ─────────────────────────────────────────────────────────
// `@nowymbot <префикс> <запрос>` — обычный поиск, но выбранный трек отдаётся
// с эффектом (перекодировка ffmpeg на выборе).
interface AudioEffect {
  /** ffmpeg `-af` цепочка. asetrate спереди с `aresample=44100` — независимо от sr источника. */
  filter: string;
  /** длительность делится на этот фактор (>1 короче, <1 длиннее) — иначе плеер врёт длину. */
  speedFactor: number;
  /** добавка к title, чтоб файл не путался с оригиналом в библиотеке. */
  suffix: string;
}

const AUDIO_EFFECTS: Record<string, AudioEffect> = {
  // asetrate поднимает и темп, и тон (~+25%, ≈ +3.86 полутона) — каноничный nightcore.
  ncore: { filter: "aresample=44100,asetrate=44100*1.25,aresample=44100", speedFactor: 1.25, suffix: "(nightcore)" },
  // atempo меняет только темп, тон сохраняется — «честное» ускорение.
  speed: { filter: "atempo=1.2", speedFactor: 1.2, suffix: "(sped up)" },
  // asetrate вниз (питч+темп ниже) + многотактовый aecho как реверб-хвост.
  slow: { filter: "aresample=44100,asetrate=44100*0.9,aresample=44100,aecho=0.8:0.85:55|95:0.35|0.25", speedFactor: 0.9, suffix: "(slowed + reverb)" },
};

const EFFECT_RE = new RegExp(`^(${Object.keys(AUDIO_EFFECTS).join("|")})\\s+(.+)`, "i");
const EFFECT_BITRATE = 320;

function parseEffect(text: string): { tier: string; effect: AudioEffect; query: string } | null {
  const m = EFFECT_RE.exec(text);
  if (m === null) return null;
  const tier = m[1]!.toLowerCase();
  return { tier, effect: AUDIO_EFFECTS[tier]!, query: m[2]!.trim() };
}

/** срезает хвостовые скобки «(...)» (перевод/алиас от Genius) для яндекс-поиска. */
function stripParen(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

type ResolveResult = { cached: CachedTrack | null; trackObj: YaTrack | null; yandex: YandexClient };

/** lossless — отдельный тир кэша; переданный lossy-`cached` для него не годится. */
async function resolveCacheEntry(
  container: Container,
  trackId: string,
  quality: AudioQuality,
  cached: CachedTrack | null,
): Promise<CachedTrack | null> {
  return quality === "lossless" ? await container.cacheDb.get(trackId, "lossless") : cached;
}

/** null, если result_id не сводится к числовому trackId. */
export function parseTrackResultId(resultId: string): string | null {
  const id = resultId.startsWith("tm:") ? resultId.slice(3) : resultId;
  return /^\d+$/.test(id) ? id : null;
}

/** InputMediaAudio для editMessageMedia + reply_markup под выбранный layout. */
export function buildChosenEditPayload(args: {
  trackId: string;
  fileId: string;
  codec: string | null;
  bitrateKbps: number | null;
  layout: string;
  lyricsQuote?: string | null;
  degraded?: boolean;
}): { media: Record<string, unknown>; markup: ReturnType<typeof trackMarkup> | undefined } {
  const { trackId, fileId, codec, bitrateKbps, layout, lyricsQuote, degraded } = args;
  const prefix = buildLyricsQuote(lyricsQuote ?? null);
  const trackCaption = buildTrackCaption(trackId, codec, bitrateKbps, degraded);

  if (layout === "none") {
    const media: Record<string, unknown> = { type: "audio", media: fileId };
    if (prefix) media.caption = prefix;
    return { media, markup: undefined };
  }
  if (layout === "text") {
    const caption = prefix ? format`${prefix}\n${trackCaption}` : trackCaption;
    return { media: { type: "audio", media: fileId, caption }, markup: undefined };
  }
  if (layout === "both") {
    const caption = prefix ? format`${prefix}\n${trackCaption}` : trackCaption;
    return { media: { type: "audio", media: fileId, caption }, markup: trackMarkup(trackId, true) };
  }
  // "button"
  const media: Record<string, unknown> = { type: "audio", media: fileId };
  if (prefix) media.caption = prefix;
  return { media, markup: trackMarkup(trackId, true) };
}

async function resolveTrack(
  container: Container,
  token: string,
  userId: number,
  trackId: string,
  trackObj: YaTrack | null = null,
): Promise<ResolveResult> {
  const trackService = await container.getTrackService(token, userId);
  const yandex = await container.getYandexService(token, userId);

  let obj = trackObj ?? trackService.getTrackObject(trackId);
  let cached: CachedTrack | null;
  if (obj !== null) {
    cached = await container.cacheDb.get(trackId);
  } else {
    [cached, obj] = await Promise.all([container.cacheDb.get(trackId), yandex.getTrackById(Number(trackId))]);
    if (obj) trackService.cacheTrackObject(obj);
  }
  return { cached, trackObj: obj, yandex };
}

/** lossless: urls зашифрованы, требуют AES-CTR-расшифровку; кэш под своим тиром. */
async function downloadFreshTrackLossless(
  container: Container,
  trackObj: YaTrack,
  yandex: YandexClient,
  trackId: string,
): Promise<[boolean, string | null, string | null, number | null]> {
  const [metadata, info] = await Promise.all([
    enrichMetadataFromAlbum(buildTrackMetadata(trackObj), trackObj, yandex),
    yandex.getLosslessDownload(trackObj),
  ]);
  if (info === null) return [false, null, null, null];
  const meta = { ...metadata, codec: info.codec, bitrate_kbps: info.bitrate };
  // каждая racing-попытка берёт случайный url из списка — естественный спред по CDN.
  const urls = info.links();
  const pickUrl = async (): Promise<string | null> =>
    urls[Math.floor(Math.random() * urls.length)] ?? null;
  const decrypt = makeEncrawDecrypt(info.key);
  const fileId = await container.cacheService.downloadAndCacheTrack(
    trackId,
    pickUrl,
    meta,
    info.codec,
    decrypt,
    "lossless",
  );
  return [true, fileId, info.codec ?? null, info.bitrate ?? null];
}

/** возвращает [infoFound, fileId, codec, bitrateKbps]. */
async function downloadFreshTrackBest(
  container: Container,
  trackObj: YaTrack,
  yandex: YandexClient,
  trackId: string,
  quality: AudioQuality,
): Promise<[boolean, string | null, string | null, number | null]> {
  const [metadata, info] = await Promise.all([
    enrichMetadataFromAlbum(buildTrackMetadata(trackObj), trackObj, yandex),
    yandex.getBestDownloadInfo(trackObj, quality),
  ]);
  if (info === null) return [false, null, null, null];
  const meta = { ...metadata, codec: info.codec, bitrate_kbps: info.bitrateInKbps };
  const fileId = await container.cacheService.downloadAndCacheTrack(
    trackId,
    () => yandex.directLinkFromInfo(info),
    meta,
    info.codec,
  );
  return [true, fileId, info.codec, info.bitrateInKbps];
}

/** degraded=true — запрошен lossless, но он не отдался, молча отдали lossy. */
async function downloadFreshTrack(
  container: Container,
  trackObj: YaTrack,
  yandex: YandexClient,
  trackId: string,
  quality: AudioQuality = "best",
): Promise<[boolean, string | null, string | null, number | null, boolean]> {
  if (quality === "lossless") {
    try {
      const r = await downloadFreshTrackLossless(container, trackObj, yandex, trackId);
      if (r[1]) return [r[0], r[1], r[2], r[3], false];
      log.warning(`[lossless] недоступен track=${trackId} → фолбэк на mp3`);
    } catch (e) {
      log.warning(`[lossless] сбой track=${trackId}: ${e} → фолбэк на mp3`);
    }
    // degraded только если фолбэк реально удался
    const fb = await downloadFreshTrackBest(container, trackObj, yandex, trackId, "best");
    return [fb[0], fb[1], fb[2], fb[3], fb[1] !== null];
  }
  const r = await downloadFreshTrackBest(container, trackObj, yandex, trackId, quality);
  return [r[0], r[1], r[2], r[3], false];
}

/** качаем lossy-исходник, перекодируем ffmpeg-фильтром, кэш — свой тир per-эффект. */
async function buildEffectTrack(
  container: Container,
  trackObj: YaTrack,
  yandex: YandexClient,
  trackId: string,
  effect: AudioEffect,
  tier: string,
): Promise<string | null> {
  const cached = await container.cacheDb.get(trackId, tier);
  if (cached && cached.is_cached) return cached.telegram_file_id;

  const [metadata, info] = await Promise.all([
    enrichMetadataFromAlbum(buildTrackMetadata(trackObj), trackObj, yandex),
    yandex.getBestDownloadInfo(trackObj, "best"),
  ]);
  if (info === null) return null;

  const meta = {
    ...metadata,
    title: `${metadata.title} ${effect.suffix}`,
    codec: "mp3",
    bitrate_kbps: EFFECT_BITRATE,
    duration: Math.round((metadata.duration || 0) / effect.speedFactor), // иначе плеер покажет старую длину
  };
  return container.cacheService.downloadAndCacheTrack(
    trackId,
    () => yandex.directLinkFromInfo(info),
    meta,
    info.codec,
    undefined,
    tier,
    { filter: effect.filter },
  );
}

async function ensureFileId(
  container: Container,
  cached: CachedTrack | null,
  trackObj: YaTrack | null,
  yandex: YandexClient,
  trackId: string,
  quality: AudioQuality = "best",
): Promise<[string | null, string | null, number | null, boolean]> {
  const entry = await resolveCacheEntry(container, trackId, quality, cached);
  if (entry && entry.is_cached) {
    return [entry.telegram_file_id, entry.codec, entry.bitrate_kbps, false];
  }
  if (!trackObj) return [null, null, null, false];
  const [, fileId, codec, bitrateKbps, degraded] = await downloadFreshTrack(container, trackObj, yandex, trackId, quality);
  return [fileId, codec, bitrateKbps, degraded];
}

async function buildEmptyResults(
  container: Container,
  trackService: SearchService,
  user: { id: number; username?: string | null; firstName?: string | null },
  opts: { layout: string; cardLayout: string; sendMode: string },
  signal?: AbortSignal,
): Promise<{ results: unknown[]; nextOffset: string }> {
  let current: { track?: YaTrack | null; progress_ms?: number; duration_ms?: number; paused?: boolean } | null = null;
  const watcher = container.npWatcher;
  if (watcher !== null && watcher.ownerId === user.id) {
    const snap = watcher.getCurrentSnapshot();
    // snap === null значит «ничего не играет», а не ошибка — как и falsy
    // track в ветке не-владельца ниже, падаем в блок «недавнее», а не выходим.
    current = snap;
    if (snap?.track) trackService.cacheTrackObject(snap.track);
  } else {
    try {
      current = await trackService.yandexService.getCurrentTrack();
    } catch (e) {
      log.warning(`[inline] не получил текущий трек: ${e}`);
      return { results: [], nextOffset: "" };
    }
  }

  const track = current?.track;
  const results: unknown[] = [];

  if (track) {
    const audio = await trackService.createInlineResultFromTrack(track, opts.layout, opts.sendMode, signal).catch((e) => {
      log.warning(`[inline] не вышло сделать результат для текущего трека: ${e}`);
      return null;
    });
    if (audio) results.push(audio);

    try {
      const cardResult = buildNowPlayingCardResult(container, track, current!, user, opts.cardLayout);
      if (cardResult) results.push(cardResult);
    } catch (e) {
      log.warning(`[inline] карточка не построена: ${e}`);
    }
  }

  // недавнее идёт тем же пагинируемым пулом, что и explicit-«недавнее» — скролл продолжает его
  const pageSize = getSettings().MAX_SEARCH_RESULTS;
  const recent = await trackService.recentResultsPaged("0", pageSize, opts.layout, opts.sendMode, signal).catch((e) => {
    log.warning(`[inline] недавнее не построилось: ${e}`);
    return { results: [] as InlineResult[], nextOffset: "" };
  });
  results.push(...recent.results);

  return { results, nextOffset: recent.nextOffset };
}

/** общий путь для deep-link и «что играет». */
export async function sendTrackToChat(args: {
  bot: Bot;
  chatId: number;
  userId: number;
  container: Container;
  trackId: string;
  trackObj?: YaTrack | null;
  token?: string | null;
  statusMsgId?: number | null;
  checkLimit?: boolean;
}): Promise<void> {
  const { bot, chatId, userId, container, trackId } = args;
  const statusMsgId = args.statusMsgId ?? null;
  let token = args.token ?? null;

  // Ynison иногда отдаёт track_id как UUID (подкасты/аудиокниги), не число — а он уходит
  // в Postgres bigint (storage/cache.ts: Number(trackId)), нечисловой даст NaN. Отсекаем явно.
  if (!/^\d+$/.test(trackId)) {
    log.warning(`[track_dm] нечисловой trackId (не catalog-трек?): ${JSON.stringify(trackId)}`);
    await say(bot, chatId, statusMsgId, format`❌ этот трек не поддерживается (не из каталога)`);
    return;
  }

  if (args.checkLimit !== false) {
    const [allowed, retryAfter] = container.downloadLimiter.check(userId);
    if (!allowed) {
      await say(bot, chatId, statusMsgId, format`⏳ слишком часто, подожди ${Math.round(retryAfter)} сек`);
      return;
    }
  }

  if (token === null) {
    token = await container.resolveToken(userId);
    if (!token) {
      await say(bot, chatId, statusMsgId, format`сначала войди — /login или жми 🔐 в меню`);
      return;
    }
  }

  try {
    const { cached, trackObj, yandex } = await resolveTrack(container, token, userId, trackId, args.trackObj ?? null);
    const quality = (await container.getUserSettings(userId)).track_quality as AudioQuality;
    const entry = await resolveCacheEntry(container, trackId, quality, cached);

    let fileId: string | null;
    let degraded = false;
    if (entry && entry.is_cached) {
      fileId = entry.telegram_file_id;
    } else {
      if (trackObj === null) {
        await say(bot, chatId, statusMsgId, format`❌ трек не найден`);
        return;
      }
      if (trackIsTooLong(trackObj)) {
        await say(
          bot, chatId, statusMsgId,
          format`❌ трек слишком длинный (${formatDurationHuman(trackObj.durationMs)}) — telegram не примет, лимит 50 мб`,
        );
        return;
      }
      if (statusMsgId !== null) {
        try {
          await bot.api.editMessageText({ chat_id: chatId, message_id: statusMsgId, text: format`⬇️ качаю...` } as never);
        } catch {
          /* ignore */
        }
      }
      const [infoFound, fid, , , deg] = await downloadFreshTrack(container, trackObj, yandex, trackId, quality);
      if (!infoFound) {
        await say(bot, chatId, statusMsgId, format`❌ нет вариантов скачивания`);
        return;
      }
      if (!fid) {
        await say(bot, chatId, statusMsgId, format`❌ не удалось скачать`);
        return;
      }
      fileId = fid;
      degraded = deg;
    }

    await bot.api.sendAudio({
      chat_id: chatId,
      audio: fileId,
      ...(degraded ? { caption: format`⚠️ превосходное недоступно — отдаю оптимальное` } : {}),
    });
    if (statusMsgId !== null) {
      try {
        await bot.api.deleteMessage({ chat_id: chatId, message_id: statusMsgId });
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    log.error(`[track_dm] ошибка user=${userId} track=${trackId}: ${e}`);
    await say(bot, chatId, statusMsgId, format`❌ ошибка, попробуй ещё раз`);
  }
}

async function fetchLyricsForQuery(
  container: Container,
  token: string,
  userId: number,
  trackId: string,
  searchPhrase: string,
  artist: string,
  title: string,
): Promise<string | null> {
  let raw: string | null = null;

  // 1) Genius по самой фразе — самый надёжный источник
  if (container.genius) {
    try {
      raw = await withTimeout(container.genius.lyricsForPhrase(searchPhrase), 8000);
    } catch (e) {
      log.warning(`[lyrics/genius-phrase] track=${trackId}: ${e}`);
    }
  }

  // 2) фолбэк: Genius по (artist, title) выбранного трека
  if (!raw && container.genius && artist && title) {
    try {
      raw = await withTimeout(container.genius.getLyrics(artist, title), 8000);
    } catch (e) {
      log.warning(`[lyrics/genius] track=${trackId}: ${e}`);
    }
  }

  if (!raw) {
    try {
      const svc = await container.getTrackService(token, userId);
      raw = await withTimeout(svc.yandexService.getTrackLyrics(trackId), 6000);
    } catch (e) {
      log.warning(`[lyrics/yandex] track=${trackId}: ${e}`);
    }
  }

  if (!raw) {
    log.info(`[lyrics] track=${trackId}: нет текста`);
    return null;
  }
  const line = findBestLyricsLine(searchPhrase, raw);
  log.info(`[lyrics] track=${trackId} phrase=${JSON.stringify(searchPhrase)} → ${JSON.stringify(line)}`);
  return line;
}

/** +3с «качаю», +8с «отправляю». cancel() дожидается завершения тикера — иначе
 * осиротевший тикер сработает уже ПОСЛЕ editMessageMedia и перетрёт «открыть» обратно. */
function startProgressTicker(bot: Bot, inlineMsgId: string, trackId: string): () => Promise<void> {
  let cancelled = false;
  const { sleep, wake } = createInterruptibleSleep();
  const done = (async () => {
    await sleep(3000);
    if (cancelled) return;
    await safeSetReplyMarkup(bot, inlineMsgId, progressMarkup(trackId, "качаю..."));
    if (cancelled) return; // отмена во время edit'а «качаю» — не входим в 8с-сон
    await sleep(8000);
    if (cancelled) return;
    await safeSetReplyMarkup(bot, inlineMsgId, progressMarkup(trackId, "отправляю..."));
  })().catch(() => undefined);
  return async () => {
    cancelled = true;
    wake();
    await done;
  };
}

// ── диспетч и пост-обработка inline-запроса ─────────────────────────────

interface QueryDispatchOpts {
  text: string;
  offset: string;
  searchText: string;
  isRecent: boolean;
  isPagedSearch: boolean;
  isLyric: boolean;
  layout: string;
  sendMode: string;
  cardLayout: string;
  pageSize: number;
  timeout: number;
}

/** общий next_offset-контракт для всех веток. */
async function dispatchQuery(
  container: Container,
  trackService: SearchService,
  user: { id: number; username?: string | null; firstName?: string | null },
  opts: QueryDispatchOpts,
  signal: AbortSignal,
): Promise<{ results: unknown[]; nextOffset: string }> {
  const { text, offset, searchText, isRecent, isPagedSearch, isLyric, layout, sendMode, cardLayout, pageSize, timeout } = opts;

  if (!text && !offset) {
    return withTimeout(buildEmptyResults(container, trackService, user, { layout, cardLayout, sendMode }, signal), timeout);
  }
  if (isRecent || (!text && offset)) {
    return withTimeout(trackService.recentResultsPaged(offset, pageSize, layout, sendMode, signal), timeout);
  }
  if (isPagedSearch) {
    return withTimeout(trackService.searchTracksPaged(text, offset, pageSize, layout, sendMode, signal), timeout);
  }
  // ссылка или лирика (searchText = genius-строка либо сама фраза)
  const results = await withTimeout(
    trackService.searchAndCreateResults(searchText, undefined, layout, sendMode, signal, isLyric),
    timeout,
  );
  return { results, nextOffset: "" };
}

/** возвращает исходный `current`, если suggest ничего не дал или перезапрос не вышел. */
async function applySuggestCorrection(
  trackService: SearchService,
  opts: { offset: string; isPagedSearch: boolean; searchText: string; layout: string; sendMode: string; pageSize: number; timeout: number },
  current: { results: unknown[]; nextOffset: string },
): Promise<{ results: unknown[]; nextOffset: string }> {
  const corrected = await trackService.yandexService.suggestCorrection(opts.searchText).catch(() => null);
  if (!corrected || corrected.toLowerCase() === opts.searchText.toLowerCase()) return current;
  log.info(`[inline/suggest] ${JSON.stringify(opts.searchText)} → ${JSON.stringify(corrected)}`);

  const cAc = new AbortController();
  try {
    if (opts.isPagedSearch) {
      return await withTimeout(
        trackService.searchTracksPaged(corrected, opts.offset, opts.pageSize, opts.layout, opts.sendMode, cAc.signal),
        opts.timeout,
      );
    }
    const results = await withTimeout(
      trackService.searchAndCreateResults(corrected, undefined, opts.layout, opts.sendMode, cAc.signal),
      opts.timeout,
    );
    return { results, nextOffset: "" };
  } catch (e) {
    cAc.abort();
    log.warning(`[inline/suggest] коррекция-поиск: ${e}`);
    return current;
  }
}

/** genius-строку («артист название») Яндекс иногда не находит — фолбэк на саму фразу. */
async function applyLyricFallback(
  trackService: SearchService,
  opts: { isLyric: boolean; lyricPhrase: string; searchText: string; layout: string; sendMode: string; timeout: number },
  currentResults: unknown[],
): Promise<unknown[]> {
  if (!opts.isLyric || currentResults.length > 0 || !opts.lyricPhrase || opts.searchText === opts.lyricPhrase) {
    return currentResults;
  }
  log.info(`[inline/lyric] фолбэк на фразу: ${JSON.stringify(opts.lyricPhrase)}`);
  // свой AbortController: первичный ac мог быть прерван по таймауту выше — его
  // signal обнулил бы фолбэк-поиск ещё на старте (safeCreateTrack бросает на aborted).
  const fbAc = new AbortController();
  try {
    return await withTimeout(
      trackService.searchAndCreateResults(opts.lyricPhrase, undefined, opts.layout, opts.sendMode, fbAc.signal, opts.isLyric),
      opts.timeout,
    );
  } catch (e) {
    fbAc.abort();
    log.warning(`[inline/lyric] фолбэк-поиск: ${e}`);
    return currentResults;
  }
}

/** трек уже закэширован в trackService при сборке аудио-результата — без лишнего сетевого вызова.
 * Мутирует `results` in place. */
function injectLyricsCard(
  container: Container,
  trackService: SearchService,
  user: { id: number; username?: string | null; firstName?: string | null },
  lyricPhrase: string,
  results: unknown[],
): void {
  if (!lyricPhrase || results.length === 0) return;
  const topId = parseTrackResultId(String((results[0] as { id?: string }).id ?? ""));
  const topTrack = topId ? trackService.getTrackObject(topId) : null;
  if (!topTrack) return;
  try {
    const card = buildLyricsCardResult(container, topTrack, lyricPhrase, user);
    if (card) results.splice(1, 0, card);
  } catch (e) {
    log.warning(`[inline/lyric] лирик-карточка не построена: ${e}`);
  }
}

// ── обработчики ──────────────────────────────────────────────────────────

async function onInlineQuery(
  ctx: {
    from: { id: number };
    query: string;
    offset?: string;
    answer(results: unknown[], params?: Record<string, unknown>): Promise<unknown>;
  },
  container: Container,
): Promise<void> {
  const userId = ctx.from.id;
  const text = ctx.query.trim();
  const offset = (ctx.offset ?? "").trim();
  log.info(`[inline] user=${userId} query=${JSON.stringify(text)} offset=${JSON.stringify(offset)}`);

  const [allowed, retryAfter] = container.inlineLimiter.check(userId);
  if (!allowed) {
    await ctx.answer([], { cache_time: 5, button: { text: `⏳ подожди ${Math.round(retryAfter)}с`, start_parameter: "start" } });
    return;
  }

  const token = await container.resolveToken(userId);
  if (!token) {
    await ctx.answer([], { cache_time: 5, button: { text: "🔑 войди через /login", start_parameter: "start" } });
    return;
  }

  const settings = await container.getUserSettings(userId);
  const layout = settings.track_layout;
  const sendMode = settings.track_send_mode;
  const cardLayout = settings.card_layout;
  const pageSize = getSettings().MAX_SEARCH_RESULTS;

  const effect = parseEffect(text);
  const isRecent = RECENT_RE.test(text);
  const isLyric = !!text && (text.startsWith('"') || text.startsWith("«"));
  const isPagedSearch = !!text && !isLyric && !isRecent && !effect && parseSearchQuery(text).type === "search";
  // оба идут через next_offset → исключаем из page0-кэша (иначе скролл сломается).
  const isPaged = isPagedSearch || isRecent;

  // быстрый путь: тот же текстовый запрос недавно искали — отдаём из кэша (file_id не меняется).
  // для пагинируемого поиска пропускаем: page0 из кэша пришёл бы без next_offset.
  // userId в ключе обязателен: без него лирик-/нп-карточка внутри results несёт
  // чужой userId/токен (см. cardPending в inlineCard.ts) — второй юзер с тем же
  // текстом получал бы чужую личность в рендере.
  if (text && !isPaged && !offset) {
    const hit = container.trackCache.get(`${userId}:${layout}:${sendMode}:${text}`);
    if (hit && hit.length > 0) {
      await ctx.answer(hit, { cache_time: 60, is_personal: true });
      return;
    }
  }

  try {
    let trackService: SearchService;
    try {
      trackService = await container.getTrackService(token, userId);
    } catch (e) {
      log.warning(`[inline] яндекс-клиент не создан user=${userId}: ${e}`);
      await ctx.answer([], { cache_time: 3, button: { text: "⏳ Яндекс не отвечает, попробуй ещё раз", start_parameter: "start" } });
      return;
    }

    // поиск по строке лирики: сначала находим саму песню через Genius (индексирует
    // тексты), затем ищем её в Яндексе по "артист — название" — точнее, чем
    // полнотекстовый поиск в Яндексе по фрагменту текста.
    let searchText = text;
    if (effect) searchText = effect.query;
    const lyricPhrase = isLyric ? text.replace(/^["«]+/, "").trim() : "";
    if (isLyric && lyricPhrase && container.genius) {
      try {
        const song = await withTimeout(container.genius.searchSong(lyricPhrase), 5000);
        searchText = song ? `${stripParen(song.artist)} ${stripParen(song.title)}`.trim() : lyricPhrase;
        log.info(`[inline/lyric] ${JSON.stringify(lyricPhrase)} → ${JSON.stringify(searchText)}`);
      } catch (e) {
        log.warning(`[inline/lyric] genius: ${e}`);
        searchText = lyricPhrase;
      }
    } else if (isLyric && lyricPhrase) {
      searchText = lyricPhrase;
    }

    const timeout = !text ? 6000 : 8000;
    // по таймауту abort'им — иначе осиротевшая работа (аплоад пустышек в канал) продолжится в фоне
    const ac = new AbortController();
    const user = ctx.from as { id: number; username?: string | null; firstName?: string | null };
    let results: unknown[] = [];
    let nextOffset = "";
    let timedOut = false;
    try {
      const built = await dispatchQuery(
        container, trackService, user,
        { text, offset, searchText, isRecent, isPagedSearch, isLyric, layout, sendMode, cardLayout, pageSize, timeout },
        ac.signal,
      );
      results = built.results;
      nextOffset = built.nextOffset;
    } catch (e) {
      ac.abort();
      log.warning(`[inline] таймаут ${timeout}ms user=${userId} text=${JSON.stringify(text)}: ${e}`);
      results = [];
      timedOut = true;
    }

    // nocorrect у /search чинит не всякую опечатку, suggest — чинит
    const correctable =
      !!text && !isLyric && !isRecent && !offset && parseSearchQuery(searchText).type === "search";
    if (correctable && results.length === 0) {
      const corrected = await applySuggestCorrection(
        trackService,
        { offset, isPagedSearch, searchText, layout, sendMode, pageSize, timeout },
        { results, nextOffset },
      );
      results = corrected.results;
      nextOffset = corrected.nextOffset;
    }

    results = await applyLyricFallback(
      trackService,
      { isLyric, lyricPhrase, searchText, layout, sendMode, timeout },
      results,
    );

    if (isLyric) injectLyricsCard(container, trackService, user, lyricPhrase, results);

    // page0-кэш только для непагинируемых — у пагинируемого окна свой кэш в resultsCache
    if (text && !isPaged && !offset && results.length > 0) {
      container.trackCache.set(`${userId}:${layout}:${sendMode}:${text}`, results as InlineResult[]);
    }

    if (results.length > 0) {
      const cacheTime = !text ? 5 : 30;
      const params: Record<string, unknown> = { cache_time: cacheTime, is_personal: true };
      if (nextOffset) params.next_offset = nextOffset;
      await ctx.answer(results, params);
    } else if (offset) {
      // nextOffset может быть непустым и тут: createTrackResultsParallel теряет
      // треки на гонке стаб-аплоада, withTimeout может обнулить всю страницу —
      // это не значит, что дальше страниц нет. Без echo Telegram решит, что
      // next_offset="" и прекратит листать с этой страницы навсегда.
      const params: Record<string, unknown> = { cache_time: 5, is_personal: true };
      if (nextOffset) params.next_offset = nextOffset;
      await ctx.answer([], params);
    } else {
      const label = timedOut
        ? "⏳ не успел, попробуй ещё раз"
        : !text
          ? "🎵 сейчас ничего не играет"
          : isRecent
            ? "🕗 пока нечего показать"
            : `❌ не найдено: ${text}`;
      await ctx.answer([], { button: { text: label, start_parameter: "start" } });
    }
  } catch (e) {
    log.error(`[inline] ошибка user=${userId} text=${JSON.stringify(text)}: ${e}`);
    try {
      await ctx.answer([], { button: { text: "❌ ошибка, попробуй позже", start_parameter: "start" } });
    } catch {
      /* query expired */
    }
  }
}

async function onChosenResult(
  ctx: { from: { id: number }; resultId: string; inlineMessageId?: string | null; query?: string | null },
  container: Container,
  bot: Bot,
): Promise<void> {
  const userId = ctx.from.id;
  const resultId = ctx.resultId;
  const inlineMsgId = ctx.inlineMessageId ?? null;
  log.info(`[chosen] user=${userId} result=${resultId}`);

  if (inlineMsgId) container.inlineOwners.set(inlineMsgId, userId);

  if (resultId.startsWith("album:")) return;

  if (isCardResultId(resultId)) {
    if (!inlineMsgId) return;
    await renderAndSwapCard(bot, container, resultId, inlineMsgId);
    return;
  }

  const isTextMedia = resultId.startsWith("tm:");
  const trackId = parseTrackResultId(resultId);
  if (trackId === null) {
    log.warning(`[chosen] невалидный result_id: ${JSON.stringify(resultId)}`);
    return;
  }
  if (!inlineMsgId) {
    log.error(`[chosen] нет inline_message_id (user=${userId} track=${trackId})`);
    return;
  }

  const token = await container.resolveToken(userId);
  if (!token) return;

  const cancelTicker = startProgressTicker(bot, inlineMsgId, trackId);

  try {
    const queryText = (ctx.query ?? "").trim();
    let searchPhrase = "";
    if (queryText.startsWith('"') || queryText.startsWith("«")) {
      searchPhrase = queryText.replace(/^["«]+/, "").trim();
    }
    const effect = parseEffect(queryText);

    const { cached, trackObj, yandex } = await resolveTrack(container, token, userId, trackId);
    const settings = await container.getUserSettings(userId);
    const quality = settings.track_quality as AudioQuality;

    let artist = "";
    let title = "";
    if (cached && cached.is_cached) {
      artist = cached.artist ?? "";
      title = cached.title ?? "";
    } else if (trackObj !== null) {
      [artist, title] = formatTrackBasics(trackObj, "");
    }

    if (trackObj === null && !(cached && cached.is_cached)) {
      log.error(`[chosen] трек ${trackId} не найден`);
      // если тикер уже успел написать «качаю...»/«отправляю...» — не оставляем
      // кнопку в этом состоянии навсегда
      await safeSetReplyMarkup(bot, inlineMsgId, retryMarkup(trackId));
      return;
    }

    if (!(cached && cached.is_cached) && trackObj && trackIsTooLong(trackObj)) {
      log.info(`[chosen] трек ${trackId} длинный — пропускаю`);
      await safeSetReplyMarkup(bot, inlineMsgId, progressMarkup(trackId, "слишком длинный"));
      return;
    }

    let fileId: string | null;
    let codec: string | null;
    let bitrateKbps: number | null;
    let degraded = false;
    let lyricsQuote: string | null = null;
    if (effect) {
      fileId = trackObj ? await buildEffectTrack(container, trackObj, yandex, trackId, effect.effect, effect.tier) : null;
      codec = "mp3";
      bitrateKbps = EFFECT_BITRATE;
    } else if (searchPhrase) {
      const [ensure, lq] = await Promise.all([
        ensureFileId(container, cached, trackObj, yandex, trackId, quality),
        fetchLyricsForQuery(container, token, userId, trackId, searchPhrase, artist, title),
      ]);
      [fileId, codec, bitrateKbps, degraded] = ensure;
      lyricsQuote = lq;
    } else {
      [fileId, codec, bitrateKbps, degraded] = await ensureFileId(container, cached, trackObj, yandex, trackId, quality);
    }

    // для lossless mp3-кэш не считается «уже на месте» — нужен своп на FLAC
    if (quality !== "lossless" && !effect && cached && cached.is_cached && !isTextMedia && !lyricsQuote) {
      log.info(`[chosen] трек ${trackId} уже в кэше user=${userId}`);
      // реальное аудио уже в сообщении (не текст-плейсхолдер) — просто чиним
      // кнопку, если тикер успел подменить её на «качаю...»/«отправляю...»
      await safeSetReplyMarkup(bot, inlineMsgId, trackMarkup(trackId, true));
      return;
    }

    if (!fileId) {
      log.error(`[chosen] скачивание не удалось track=${trackId}`);
      await safeSetReplyMarkup(bot, inlineMsgId, retryMarkup(trackId));
      return;
    }

    const layout = settings.track_layout;
    const { media, markup } = buildChosenEditPayload({
      trackId, fileId, codec, bitrateKbps, layout, lyricsQuote, degraded,
    });

    await cancelTicker(); // ДО edit'а: иначе «отправляю…» тикера легло бы поверх аудио

    await safeEditMedia(bot, { inlineMessageId: inlineMsgId }, media, markup);
    log.info(`[chosen] трек ${trackId} отправлен user=${userId}${degraded ? " (FLAC→mp3)" : ""}`);
  } catch (e) {
    log.error(`[chosen] ошибка user=${userId} track=${trackId}: ${e}`);
  } finally {
    await cancelTicker();
  }
}

async function onLoadCallback(
  ctx: {
    inlineMessageId?: string | null;
    from: { id: number };
    answer(params?: string | { text?: string; show_alert?: boolean }): Promise<unknown>;
  },
  container: Container,
  bot: Bot,
): Promise<void> {
  const data = cbData(ctx);
  const raw = data.includes(":") ? data.split(":", 2)[1] ?? "" : "";
  if (!/^\d+$/.test(raw)) {
    await safeAnswerCb(ctx, { text: "некорректный track_id", show_alert: true });
    return;
  }
  const trackId = raw;
  const inlineMsgId = ctx.inlineMessageId ?? null;
  const userId = ctx.from.id;

  if (!inlineMsgId) {
    await safeAnswerCb(ctx, { text: "что-то пошло не так", show_alert: true });
    return;
  }

  // в группе кнопку видят все, рулить может только владелец инлайна;
  // владелец неизвестен (рестарт/эвикт) → пропускаем (мягкая деградация)
  const owner = container.inlineOwners.get(inlineMsgId);
  if (owner !== null && owner !== userId) {
    log.info(`[load] чужой инлайн: tapper=${userId} owner=${owner} track=${trackId}`);
    await safeAnswerCb(ctx, { text: "это не твой трек — запусти инлайн сам", show_alert: true });
    return;
  }

  const [allowed, retryAfter] = container.downloadLimiter.check(userId);
  if (!allowed) {
    await safeAnswerCb(ctx, { text: `⏳ слишком часто, подожди ${Math.round(retryAfter)} сек`, show_alert: true });
    return;
  }

  const token = await container.resolveToken(userId);
  if (!token) {
    await safeAnswerCb(ctx, { text: "сначала войди через /login", show_alert: true });
    return;
  }

  try {
    const { cached, trackObj, yandex } = await resolveTrack(container, token, userId, trackId);
    const settings = await container.getUserSettings(userId);
    const quality = settings.track_quality as AudioQuality;
    const entry = await resolveCacheEntry(container, trackId, quality, cached);
    let fileId: string | null;
    let codec: string | null;
    let bitrateKbps: number | null;
    let degraded = false;
    if (entry && entry.is_cached) {
      fileId = entry.telegram_file_id;
      codec = entry.codec;
      bitrateKbps = entry.bitrate_kbps;
    } else {
      if (trackObj === null) {
        await safeAnswerCb(ctx, { text: "трек не найден", show_alert: true });
        return;
      }
      if (trackIsTooLong(trackObj)) {
        await safeAnswerCb(ctx, { text: `трек слишком длинный (${formatDurationHuman(trackObj.durationMs)}) — telegram не примет`, show_alert: true });
        return;
      }
      const [infoFound, fid, c, b, deg] = await downloadFreshTrack(container, trackObj, yandex, trackId, quality);
      if (!infoFound) {
        await safeAnswerCb(ctx, { text: "нет вариантов скачивания", show_alert: true });
        return;
      }
      fileId = fid;
      codec = c;
      bitrateKbps = b;
      degraded = deg;
    }

    if (!fileId) {
      await safeAnswerCb(ctx, { text: "не удалось загрузить, попробуй ещё раз", show_alert: true });
      return;
    }

    // единственный оставшийся answerCallbackQuery на этот callback_query_id —
    // держим его до сюда: Telegram позволяет ответить только раз, а все ошибки
    // выше (нет токена/трека/слишком длинный/нет вариантов/не удалось) должны
    // реально доходить до юзера, а не проглатываться этим вызовом раньше времени.
    await safeAnswerCb(ctx, degraded ? "⚠️ превосходное недоступно — отдаю оптимальное" : "загружаю...");
    const layout = settings.track_layout;
    const { media, markup } = buildChosenEditPayload({ trackId, fileId, codec, bitrateKbps, layout, degraded });
    await safeEditMedia(bot, { inlineMessageId: inlineMsgId }, media, markup);
    log.info(`[load] трек ${trackId} загружен user=${userId}${degraded ? " (FLAC→mp3)" : ""}`);
  } catch (e) {
    log.error(`[load] ошибка user=${userId} track=${trackId}: ${e}`);
  }
}

/** кнопка статична (❤️ без состояния) — клаву не перерисовываем, результат тостом. */
async function onLikeCallback(
  ctx: {
    from: { id: number };
    answer(params?: string | { text?: string; show_alert?: boolean }): Promise<unknown>;
  },
  container: Container,
): Promise<void> {
  const parts = cbData(ctx).split(":");
  const raw = parts[2] ?? "";
  if (!/^\d+$/.test(raw)) {
    await safeAnswerCb(ctx, { text: "что-то пошло не так", show_alert: true });
    return;
  }
  const trackId = raw;
  const userId = ctx.from.id;

  const token = await container.resolveToken(userId);
  if (!token) {
    await safeAnswerCb(ctx, { text: "сначала войди в бота — /login", show_alert: true });
    return;
  }

  try {
    const yandex = await container.getYandexService(token, userId);
    const liked = await yandex.isTrackLiked(trackId);
    const ok = await yandex.setTrackLiked(trackId, !liked);
    if (!ok) {
      await safeAnswerCb(ctx, { text: "не вышло, попробуй ещё раз", show_alert: true });
      return;
    }
    await safeAnswerCb(ctx, !liked ? "❤️ лайкнул" : "убрал лайк");
  } catch (e) {
    log.error(`[like] ошибка user=${userId} track=${trackId}: ${e}`);
    await safeAnswerCb(ctx, { text: "ошибка, попробуй ещё раз", show_alert: true });
  }
}

export function registerInline(bot: Bot, container: Container): void {
  bot.inlineQuery(/[\s\S]*/, (ctx) => onInlineQuery(ctx as never, container));
  bot.chosenInlineResult(/[\s\S]*/, (ctx) => onChosenResult(ctx as never, container, bot));
  bot.callbackQuery(/^load:/, (ctx) => onLoadCallback(ctx as never, container, bot));
  bot.callbackQuery(/^like:/, (ctx) => onLikeCallback(ctx as never, container));
}
