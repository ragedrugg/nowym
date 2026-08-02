/** Genius: поиск песни по строке лирики + скрейп текста. Клиент на node-wreq
 * (Rust-ядро, browser-impersonation) вместо undici-based клиентов — undici
 * конфликтует по версиям под tsx. */

import { parse, TextNode } from "node-html-parser";
import { fetch } from "node-wreq";
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

  constructor(token: string) {
    this.token = token;
  }

  /** Поиск песни по произвольной строке (напр. фрагменту лирики) → artist/title
   * верхнего подходящего результата. Genius индексирует тексты песен, поэтому
   * находит трек по одной лишь строке из него. */
  async searchSong(query: string): Promise<{ artist: string; title: string } | null> {
    const key = query.toLowerCase();
    if (this.songCache.has(key)) {
      const h = this.songCache.get(key) ?? null;
      return h ? { artist: h.artist, title: h.title } : null;
    }

    let hit: Hit | null = null;
    try {
      hit = pickHit(await this.apiSearch(query));
    } catch (e) {
      log.warning(`[genius] поиск песни: ${errStr(e)}`);
    }
    this.songCache.set(key, hit);
    log.info(
      hit
        ? `[genius] песня найдена: ${JSON.stringify(query)} → ${hit.artist} — ${hit.title}`
        : `[genius] песня не найдена: ${JSON.stringify(query)}`,
    );
    return hit ? { artist: hit.artist, title: hit.title } : null;
  }

  /** Лирика песни, найденной searchSong(phrase) — скрейп именно того результата.
   * Ленивый: скрейп откладываем до явного вызова (на chosen, не на каждый ввод). */
  async lyricsForPhrase(phrase: string): Promise<string | null> {
    const key = phrase.toLowerCase();
    const cached = this.phraseLyrics.get(key);
    if (cached !== undefined) return cached;

    if (!this.songCache.has(key)) await this.searchSong(phrase);
    const hit = this.songCache.get(key) ?? null;
    const text = hit ? await this.scrapeLyrics(hit.url) : null;

    this.phraseLyrics.set(key, text);
    log.info(
      text
        ? `[genius] лирика по фразе ${JSON.stringify(phrase)} (${text.length} симв.)`
        : `[genius] лирика по фразе не найдена: ${JSON.stringify(phrase)}`,
    );
    return text;
  }

  /** Лирика по (артист, название) — фолбэк, когда нет фразы. */
  async getLyrics(artist: string, title: string): Promise<string | null> {
    const key = `${artist.toLowerCase()}|${title.toLowerCase()}`;
    const cached = this.byArtistTitle.get(key);
    if (cached !== undefined) return cached;

    let text: string | null = null;
    try {
      const hit = pickHit(await this.apiSearch(`${title} ${artist}`));
      if (hit) text = await this.scrapeLyrics(hit.url);
    } catch (e) {
      log.warning(`[genius] ошибка: ${errStr(e)}`);
    }
    this.byArtistTitle.set(key, text);
    log.info(
      text
        ? `[genius] лирика получена: ${JSON.stringify(artist)} — ${JSON.stringify(title)} (${text.length} симв.)`
        : `[genius] текст не найден: ${JSON.stringify(artist)} — ${JSON.stringify(title)}`,
    );
    return text;
  }

  /** GET /search — официальный Genius API (Bearer-токен), JSON с хитами. */
  private async apiSearch(query: string): Promise<Hit[]> {
    const url = `${API_BASE}/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
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
  private async scrapeLyrics(url: string): Promise<string | null> {
    const cached = this.lyricsByUrl.get(url);
    if (cached !== undefined) return cached;

    let text: string | null = null;
    try {
      const res = await fetch(url, { browser: BROWSER });
      if (!res.ok) throw new Error(`page HTTP ${res.status}`);
      const html = await res.text();
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
    }
    this.lyricsByUrl.set(url, text);
    return text;
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
