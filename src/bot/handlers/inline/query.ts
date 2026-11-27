import { withTimeout } from "../../../infra/async.ts";
import { getLogger } from "../../../infra/logging.ts";
import { parseSearchQuery } from "../../../infra/parsers.ts";
import type { InlineResult, SearchService } from "../../../services/search.ts";
import { getSettings } from "../../../settings.ts";
import { YandexUnavailableError } from "../../../yandex/client.ts";
import type { YaTrack } from "../../../yandex/types.ts";
import type { Container } from "../../container.ts";
import { errText } from "../../richMessage.ts";
import {
  ERROR_RETRY,
  INLINE_NOTHING_RECENT,
  INLINE_SERVICE_DOWN,
  INLINE_TIMED_OUT,
  inlineNotFound,
  LOGIN_INLINE_BUTTON,
  NOTHING_PLAYING,
  tooOften,
  YANDEX_DOWN,
} from "../../texts.ts";
import type { TgUser } from "../../types.ts";
import { buildLyricsCardResult, buildNowPlayingCardResult, buildRichNowPlayingResult } from "../inlineCard.ts";
import { EMPTY_ANSWER_PARAMS, parseEffect, parseTrackResultId } from "./shared.ts";

const log = getLogger("bot.inline");

const RECENT_RE = /^(недавн(ее|ие)|recent|истори[яю])$/i;

/** срезает хвостовые скобки «(...)» (перевод/алиас от Genius) для яндекс-поиска. */
function stripParen(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

export async function buildEmptyResults(
  container: Container,
  trackService: SearchService,
  user: TgUser,
  opts: { layout: string; cardLayout: string; sendMode: string; richMessages?: boolean },
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
      // сбой Ynison не повод терять «недавнее»: пропускаем блок «сейчас играет»
      log.warning(`[inline] не получил текущий трек: ${e}`);
      current = null;
    }
  }

  const track = current?.track;
  const results: unknown[] = [];

  if (track) {
    // «карточка+трек» первым; обычные аудио и карточка остаются следом (старые клиенты)
    if (opts.richMessages) {
      try {
        const rich = buildRichNowPlayingResult(container, track, current!, user);
        if (rich) results.push(rich);
      } catch (e) {
        log.warning(`[inline] rich-плейсхолдер не построен: ${errText(e)}`);
      }
    }
    const audio = await trackService
      .createInlineResultFromTrack(track, opts.layout, opts.sendMode, signal)
      .catch((e) => {
        log.warning(`[inline] не вышло сделать результат для текущего трека: ${e}`);
        return null;
      });
    if (audio) results.push(audio);

    try {
      const cardResult = buildNowPlayingCardResult(container, track, current!, user, opts.cardLayout);
      if (cardResult) results.push(cardResult);
    } catch (e) {
      log.warning(`[inline] карточка не построена: ${errText(e)}`);
    }
  }

  // недавнее идёт тем же пагинируемым пулом, что и explicit-«недавнее» — скролл продолжает его
  const pageSize = getSettings().MAX_SEARCH_RESULTS;
  const recent = await trackService.recentResultsPaged("0", pageSize, opts.layout, opts.sendMode, signal).catch((e) => {
    log.warning(`[inline] недавнее не построилось: ${e}`);
    return { results: [] as InlineResult[], nextOffset: "" };
  });
  // текущий трек нередко есть и в «недавнем» (его же только что слушали), а id результата
  // строится от trackId — идентичные id Telegram отвергает ВЕСЬ ответ (RESULT_ID_DUPLICATE)
  // целиком, а не только дубль. Оставляем первый (из «текущего»).
  results.push(...recent.results);

  return { results: dedupeResultsById(results), nextOffset: recent.nextOffset };
}

/** убирает результаты с повторяющимся id, сохраняя порядок и первый экземпляр. */
export function dedupeResultsById(results: unknown[]): unknown[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const id = (r as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
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
  richMessages: boolean;
  pageSize: number;
  timeout: number;
}

/** общий next_offset-контракт для всех веток. */
async function dispatchQuery(
  container: Container,
  trackService: SearchService,
  user: TgUser,
  opts: QueryDispatchOpts,
  signal: AbortSignal,
): Promise<{ results: unknown[]; nextOffset: string }> {
  const {
    text,
    offset,
    searchText,
    isRecent,
    isPagedSearch,
    isLyric,
    layout,
    sendMode,
    cardLayout,
    richMessages,
    pageSize,
    timeout,
  } = opts;

  if (!text && !offset) {
    return withTimeout(
      buildEmptyResults(container, trackService, user, { layout, cardLayout, sendMode, richMessages }, signal),
      timeout,
    );
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
  opts: {
    offset: string;
    isPagedSearch: boolean;
    searchText: string;
    layout: string;
    sendMode: string;
    pageSize: number;
    timeout: number;
  },
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
    if (e instanceof YandexUnavailableError) throw e; // «Яндекс не отвечает», а не «не найдено»
    log.warning(`[inline/suggest] коррекция-поиск: ${e}`);
    return current;
  }
}

/** genius-строку («артист название») Яндекс иногда не находит — фолбэк на саму фразу. */
async function applyLyricFallback(
  trackService: SearchService,
  opts: {
    isLyric: boolean;
    lyricPhrase: string;
    searchText: string;
    layout: string;
    sendMode: string;
    timeout: number;
  },
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
      trackService.searchAndCreateResults(
        opts.lyricPhrase,
        undefined,
        opts.layout,
        opts.sendMode,
        fbAc.signal,
        opts.isLyric,
      ),
      opts.timeout,
    );
  } catch (e) {
    fbAc.abort();
    if (e instanceof YandexUnavailableError) throw e; // «Яндекс не отвечает», а не «не найдено»
    log.warning(`[inline/lyric] фолбэк-поиск: ${e}`);
    return currentResults;
  }
}

/** трек уже закэширован в trackService при сборке аудио-результата — без лишнего сетевого вызова.
 * Мутирует `results` in place. */
function injectLyricsCard(
  container: Container,
  trackService: SearchService,
  user: TgUser,
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

/** ссылка на трек в inline: к аудио-результату добавляем карточку (и «карточка+трек» при rich) —
 * без линии прогресса, позиции воспроизведения у ссылки нет. Мутирует `results`. */
export function injectTrackLinkCards(
  container: Container,
  trackService: SearchService,
  user: TgUser,
  opts: { text: string; richMessages: boolean; cardLayout: string },
  results: unknown[],
): void {
  // «ncore <ссылка>» — это трек с эффектом, карточки к нему не нужны
  if (results.length === 0 || parseEffect(opts.text) || parseSearchQuery(opts.text).type !== "track_link") return;
  const topId = parseTrackResultId(String((results[0] as { id?: string }).id ?? ""));
  const track = topId ? trackService.getTrackObject(topId) : null;
  if (!track) return;
  const noPlayback = { progress_ms: 0, duration_ms: track.durationMs ?? 0, paused: false };
  try {
    const card = buildNowPlayingCardResult(container, track, noPlayback, user, opts.cardLayout, true);
    if (card) results.splice(1, 0, card);
    if (opts.richMessages) {
      const rich = buildRichNowPlayingResult(container, track, noPlayback, user, true);
      if (rich) results.unshift(rich);
    }
  } catch (e) {
    log.warning(`[inline/link] карточка по ссылке не построена: ${errText(e)}`);
  }
}

/** поиск по названию при включённом rich_messages: перед аудио каждого трека — «карточка + трек».
 * Плейсхолдер лёгкий (без сети, трек уже в кэше trackService); позиции воспроизведения у
 * найденного трека нет, поэтому карточка без линии прогресса. Мутирует `results`. */
export function injectRichSearchCards(
  container: Container,
  trackService: SearchService,
  user: TgUser,
  opts: { richMessages: boolean; isPagedSearch: boolean },
  results: unknown[],
): void {
  if (!opts.richMessages || !opts.isPagedSearch || results.length === 0) return;
  for (let i = 0; i < results.length; i++) {
    const trackId = parseTrackResultId(String((results[i] as { id?: string }).id ?? ""));
    const track = trackId ? trackService.getTrackObject(trackId) : null;
    if (!track) continue;
    try {
      const rich = buildRichNowPlayingResult(
        container,
        track,
        { progress_ms: 0, duration_ms: track.durationMs ?? 0, paused: false },
        user,
        true,
      );
      if (rich) {
        results.splice(i, 0, rich);
        i++; // аудио сдвинулось на одну позицию вправо
      }
    } catch (e) {
      log.warning(`[inline/search] карточка+трек не построена: ${errText(e)}`);
    }
  }
}

// ── обработчики ──────────────────────────────────────────────────────────

export async function onInlineQuery(
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
  // текст запроса — DEBUG: приватность и объём лога (INFO пишется на каждый символ набора)
  log.debug(`[inline] user=${userId} query=${JSON.stringify(text)} offset=${JSON.stringify(offset)}`);

  const [allowed, retryAfter] = container.inlineLimiter.check(userId);
  if (!allowed) {
    await ctx.answer([], {
      ...EMPTY_ANSWER_PARAMS,
      button: { text: tooOften(retryAfter), start_parameter: "start" },
    });
    return;
  }

  const token = await container.resolveToken(userId);
  if (!token) {
    await ctx.answer([], {
      ...EMPTY_ANSWER_PARAMS,
      button: { text: LOGIN_INLINE_BUTTON, start_parameter: "login" },
    });
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
  // card_layout и rich_messages в ключе: они меняют состав и разметку карточек внутри results.
  const page0Key = `${userId}:${layout}:${sendMode}:${cardLayout}:${settings.rich_messages ? 1 : 0}:${text}`;
  if (text && !isPaged && !offset) {
    const hit = container.trackCache.get(page0Key);
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
      await ctx.answer([], {
        ...EMPTY_ANSWER_PARAMS,
        button: { text: INLINE_SERVICE_DOWN, start_parameter: "start" },
      });
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
    const user = ctx.from as TgUser;
    let results: unknown[] = [];
    let nextOffset = "";
    let timedOut = false;
    let unavailable = false;
    try {
      const built = await dispatchQuery(
        container,
        trackService,
        user,
        {
          text,
          offset,
          searchText,
          isRecent,
          isPagedSearch,
          isLyric,
          layout,
          sendMode,
          cardLayout,
          richMessages: settings.rich_messages,
          pageSize,
          timeout,
        },
        ac.signal,
      );
      results = [...built.results]; // свой массив: дальше в него вставляются карточки
      nextOffset = built.nextOffset;
    } catch (e) {
      ac.abort();
      results = [];
      // сбой на странице прокрутки: эхо текущего offset — иначе Telegram сочтёт выдачу законченной
      if (offset) nextOffset = offset;
      if (e instanceof YandexUnavailableError) {
        unavailable = true;
      } else {
        log.warning(`[inline] таймаут ${timeout}ms user=${userId} text=${JSON.stringify(text)}: ${e}`);
        timedOut = true;
      }
    }

    // nocorrect у /search чинит не всякую опечатку, suggest — чинит; при сбое Яндекса не дёргаем его зря
    const correctable =
      !unavailable && !!text && !isLyric && !isRecent && !offset && parseSearchQuery(searchText).type === "search";
    try {
      if (correctable && results.length === 0) {
        const corrected = await applySuggestCorrection(
          trackService,
          { offset, isPagedSearch, searchText, layout, sendMode, pageSize, timeout },
          { results, nextOffset },
        );
        results = corrected.results;
        nextOffset = corrected.nextOffset;
      }

      if (!unavailable) {
        results = await applyLyricFallback(
          trackService,
          { isLyric, lyricPhrase, searchText, layout, sendMode, timeout },
          results,
        );
      }
    } catch (e) {
      if (!(e instanceof YandexUnavailableError)) throw e;
      log.warning(`[inline] ${e.message} (коррекция/фолбэк) user=${userId}`);
      unavailable = true;
    }

    if (isLyric) injectLyricsCard(container, trackService, user, lyricPhrase, results);
    injectTrackLinkCards(
      container,
      trackService,
      user,
      { text, richMessages: settings.rich_messages, cardLayout },
      results,
    );
    injectRichSearchCards(
      container,
      trackService,
      user,
      { richMessages: settings.rich_messages, isPagedSearch },
      results,
    );

    // page0-кэш только для непагинируемых — у пагинируемого окна свой кэш в resultsCache
    if (text && !isPaged && !offset && results.length > 0) {
      container.trackCache.set(page0Key, [...results] as InlineResult[]);
    }

    if (results.length > 0) {
      const cacheTime = !text ? 5 : 30;
      const params: Record<string, unknown> = { cache_time: cacheTime, is_personal: true };
      if (nextOffset) params.next_offset = nextOffset;
      // последняя страховка: дубль id в любой ветке (текущий+недавнее, карточка+трек) уронил бы весь ответ
      await ctx.answer(dedupeResultsById(results) as typeof results, params);
    } else if (offset) {
      // nextOffset может быть непустым и тут: createTrackResultsParallel теряет
      // треки на гонке стаб-аплоада, withTimeout может обнулить всю страницу —
      // это не значит, что дальше страниц нет. Без echo Telegram решит, что
      // next_offset="" и прекратит листать с этой страницы навсегда.
      const params: Record<string, unknown> = { ...EMPTY_ANSWER_PARAMS };
      if (nextOffset) params.next_offset = nextOffset;
      await ctx.answer([], params);
    } else {
      const label = unavailable
        ? YANDEX_DOWN
        : timedOut
          ? INLINE_TIMED_OUT
          : !text
            ? NOTHING_PLAYING
            : isRecent
              ? INLINE_NOTHING_RECENT
              : inlineNotFound(text);
      await ctx.answer([], { ...EMPTY_ANSWER_PARAMS, button: { text: label, start_parameter: "start" } });
    }
  } catch (e) {
    log.error(`[inline] ошибка user=${userId} text=${JSON.stringify(text)}: ${e}`);
    try {
      await ctx.answer([], {
        ...EMPTY_ANSWER_PARAMS,
        button: { text: ERROR_RETRY, start_parameter: "start" },
      });
    } catch {
      /* query expired */
    }
  }
}
