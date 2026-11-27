/** Genius: поиск песни по строке лирики + скрейп текста. Клиент на node-wreq
 * (Rust-ядро, browser-impersonation) вместо undici-based клиентов — undici
 * конфликтует по версиям под tsx. */

// node-wreq (нативный аддон) и node-html-parser грузятся лениво при первом запросе:
// Genius нужен редко, а статический импорт держал бы их в памяти с самого старта.
import type { fetch as wreqFetch } from "node-wreq";
import { getLogger } from "../infra/logging.ts";
import { LRUMap } from "../infra/lruMap.ts";

const log = getLogger("genius");

const API_BASE = "https://api.genius.com";
// имперсонация браузера — genius.com отдаёт страницу с лирикой только «людям»
const BROWSER = "chrome_140";
// term'ы для отсечения неподходящих версий песни
const EXCLUDED_TERMS = ["(remix)", "(live)"];
// заголовки секций вида [Chorus]/[Verse] вырезаем из текста
const SECTION_HEADER_RE = /^\[.*\]$/;
// definitive-негатив («не найдено») помним недолго и потом пробуем снова;
// исключения/429/5xx/Cloudflare не кэшируем вовсе
const NEGATIVE_TTL_MS = 15 * 60_000;

export interface GeniusDeps {
  fetch?: typeof wreqFetch;
  now?: () => number;
}

/** результат шага: definitive=false — временный сбой, кэшировать нельзя. */
interface Step<T> {
  value: T | null;
  definitive: boolean;
}

interface Hit {
  title: string;
  artist: string;
  url: string;
}

export class GeniusClient {
  private token: string;
  // phrase → найденный hit (объект песни), чтобы lyricsForPhrase скрейпил
  // именно его, а не перезапрашивал по (artist, title).
  private songCache = new LRUMap<string, Hit | null>(500);
  private phraseLyrics = new LRUMap<string, string | null>(500);
  private lyricsByUrl = new LRUMap<string, string | null>(500);
  private byArtistTitle = new LRUMap<string, string | null>(500);

  // key → момент (мс), до которого помним definitive-негатив
  private negUntil = new LRUMap<string, number>(2000);
  private readonly fetchFn: typeof wreqFetch;
  private readonly now: () => number;

  constructor(token: string, deps: GeniusDeps = {}) {
    this.token = token;
    this.fetchFn = deps.fetch ?? (async (...args) => (await import("node-wreq")).fetch(...args));
    this.now = deps.now ?? Date.now;
  }

  private isNeg(key: string): boolean {
    const until = this.negUntil.peek(key);
    return until !== undefined && until > this.now();
  }

  private setNeg(key: string): void {
    this.negUntil.set(key, this.now() + NEGATIVE_TTL_MS);
  }

  /** Поиск песни по произвольной строке (напр. фрагменту лирики) → artist/title
   * верхнего подходящего результата. Genius индексирует тексты песен, поэтому
   * находит трек по одной лишь строке из него. */
  async searchSong(query: string): Promise<{ artist: string; title: string } | null> {
    const h = (await this.searchHit(query)).value;
    return h ? { artist: h.artist, title: h.title } : null;
  }

  private async searchHit(query: string): Promise<Step<Hit>> {
    const key = query.toLowerCase();
    const cached = this.songCache.get(key);
    if (cached) return { value: cached, definitive: true };
    if (this.isNeg(`s:${key}`)) return { value: null, definitive: true };

    let hit: Hit | null = null;
    try {
      hit = pickHit(await this.apiSearch(query));
    } catch (e) {
      log.warning(`[genius] поиск песни: ${errStr(e)}`);
      return { value: null, definitive: false };
    }
    if (hit) this.songCache.set(key, hit);
    else this.setNeg(`s:${key}`);
    log.info(
      hit
        ? `[genius] песня найдена: ${JSON.stringify(query)} → ${hit.artist} — ${hit.title}`
        : `[genius] песня не найдена: ${JSON.stringify(query)}`,
    );
    return { value: hit, definitive: true };
  }

  /** Лирика песни, найденной searchSong(phrase) — скрейп именно того результата.
   * Ленивый: скрейп откладываем до явного вызова (на chosen, не на каждый ввод). */
  async lyricsForPhrase(phrase: string): Promise<string | null> {
    const key = phrase.toLowerCase();
    const cached = this.phraseLyrics.get(key);
    if (cached) return cached;
    if (this.isNeg(`p:${key}`)) return null;

    const found = await this.searchHit(phrase);
    const res: Step<string> = found.value
      ? await this.scrapeLyrics(found.value.url)
      : { value: null, definitive: found.definitive };

    if (res.value) this.phraseLyrics.set(key, res.value);
    else if (res.definitive) this.setNeg(`p:${key}`);
    log.info(
      res.value
        ? `[genius] лирика по фразе ${JSON.stringify(phrase)} (${res.value.length} симв.)`
        : `[genius] лирика по фразе не найдена: ${JSON.stringify(phrase)}`,
    );
    return res.value;
  }

  /** Лирика по (артист, название) — фолбэк, когда нет фразы. */
  async getLyrics(artist: string, title: string): Promise<string | null> {
    const key = `${artist.toLowerCase()}|${title.toLowerCase()}`;
    const cached = this.byArtistTitle.get(key);
    if (cached) return cached;
    if (this.isNeg(`a:${key}`)) return null;

    let res: Step<string> = { value: null, definitive: true };
    try {
      const hit = pickHit(await this.apiSearch(`${title} ${artist}`));
      if (hit) res = await this.scrapeLyrics(hit.url);
    } catch (e) {
      log.warning(`[genius] ошибка: ${errStr(e)}`);
      res = { value: null, definitive: false };
    }
    if (res.value) this.byArtistTitle.set(key, res.value);
    else if (res.definitive) this.setNeg(`a:${key}`);
    log.info(
      res.value
        ? `[genius] лирика получена: ${JSON.stringify(artist)} — ${JSON.stringify(title)} (${res.value.length} симв.)`
        : `[genius] текст не найден: ${JSON.stringify(artist)} — ${JSON.stringify(title)}`,
    );
    return res.value;
  }

  /** GET /search — официальный Genius API (Bearer-токен), JSON с хитами. */
  private async apiSearch(query: string): Promise<Hit[]> {
    const url = `${API_BASE}/search?q=${encodeURIComponent(query)}`;
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${this.token}` },
      browser: BROWSER,
    });
    if (!res.ok) throw new Error(`search HTTP ${res.status}`);
    const data = await res.json<GeniusSearchResponse>();
    const hits = data.response?.hits ?? [];
    return hits
      .map((h) => h.result)
      .filter((r): r is NonNullable<typeof r> => Boolean(r && r.title && r.url))
      .map((r) => ({
        title: (r.title ?? "").trim(),
        artist: (r.primary_artist?.name ?? "").trim(),
        url: r.url!,
      }));
  }

  /** GET страницы песни + извлечение текста из [data-lyrics-container]. */
  private async scrapeLyrics(url: string): Promise<Step<string>> {
    const cached = this.lyricsByUrl.get(url);
    if (cached) return { value: cached, definitive: true };
    if (this.isNeg(`u:${url}`)) return { value: null, definitive: true };

    let text: string | null = null;
    try {
      const res = await this.fetchFn(url, { browser: BROWSER });
      if (res.status === 404) {
        this.setNeg(`u:${url}`);
        return { value: null, definitive: true };
      }
      if (!res.ok) throw new Error(`page HTTP ${res.status}`);
      const html = await res.text();
      const { parse, TextNode } = await import("node-html-parser");
      const doc = parse(html);
      const root = doc.getElementById("lyrics-root") ?? doc;
      const containers = root.querySelectorAll("[data-lyrics-container='true']");
      const parts = containers.map((c) => {
        // выкидываем UI-хром (счётчик контрибьюторов, заголовок, переводы)
        c.querySelectorAll("[data-exclude-from-selection='true']").forEach((n) => {
          n.remove();
        });
        c.querySelectorAll("br").forEach((br) => {
          br.replaceWith(new TextNode("\n"));
        });
        return c.text;
      });
      const joined = parts.join("\n").trim();
      if (joined) text = stripSectionHeaders(joined).trim();
    } catch (e) {
      log.warning(`[genius] скрейп лирики: ${errStr(e)}`);
      return { value: null, definitive: false };
    }
    if (text) this.lyricsByUrl.set(url, text);
    else this.setNeg(`u:${url}`);
    return { value: text || null, definitive: true };
  }
}

interface GeniusSearchResponse {
  response?: {
    hits?: Array<{
      result?: { title?: string; url?: string; primary_artist?: { name?: string } };
    }>;
  };
}

/** первый результат не remix/live. */
function pickHit(hits: Hit[]): Hit | null {
  for (const h of hits) {
    if (!h.title) continue;
    if (EXCLUDED_TERMS.some((t) => h.title.toLowerCase().includes(t))) continue;
    return h;
  }
  return null;
}

/** убирает строки-заголовки секций вида [Chorus] и т.п. */
function stripSectionHeaders(lyrics: string): string {
  return lyrics
    .split("\n")
    .filter((line) => !SECTION_HEADER_RE.test(line.trim()))
    .join("\n");
}

function errStr(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
