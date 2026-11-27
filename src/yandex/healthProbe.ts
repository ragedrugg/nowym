/** Read-only health-отчёт Яндекс Музыки (YandexClient.probeApiHealth). */
import { performance } from "node:perf_hooks";
import type {
  Client as LibClient,
  DownloadInfo as LibDownloadInfo,
  LosslessDownloadInfo as LibLosslessDownloadInfo,
} from "@dvxch/yandex-music";
import { withTimeout } from "../infra/async.ts";
import type { HttpClient } from "../infra/http.ts";
import type { AsyncTokenGate } from "../infra/rateLimit.ts";
import { AUDIO_MAGIC_BYTES, assertAudioMagic } from "./audioMagic.ts";
import { isLosslessInfo } from "./download.ts";
import {
  errorDetail,
  overallFromChecks,
  sortHealthChecks,
  type YandexHealthCheck,
  type YandexHealthReport,
  type YandexProbeTrack,
} from "./health.ts";
import { bareTrackId, selectDownloadInfo } from "./metadata.ts";

export interface ApiHealthProbeOptions {
  /** HTTP-клиент бота — для Range-проверки CDN без скачивания файла. */
  http: HttpClient;
  /** id текущего/последнего трека; если нет — возьмём из поиска/истории. */
  probeTrackId?: string | number | null;
  /** таймаут одной проверки (не всего отчёта). */
  timeoutMs?: number;
}

const HEALTH_DEPENDENT: Array<Pick<YandexHealthCheck, "key" | "label" | "critical">> = [
  { key: "search", label: "поиск", critical: true },
  { key: "catalog", label: "каталог / треки", critical: true },
  { key: "download_lossy", label: "загрузка mp3/aac", critical: true },
  { key: "download_lossless", label: "lossless / get-file-info", critical: true },
  { key: "cdn", label: "CDN", critical: true },
  { key: "lyrics", label: "лирика", critical: false },
  { key: "likes", label: "лайки", critical: false },
  { key: "history", label: "история", critical: false },
];

// Эталонные треки для проверок, которые нельзя делать на случайном текущем
// треке: у него может не быть FLAC или текста. ID из официального каталога,
// где lossless/лирика точно должны существовать.
const LOSSLESS_PROBE_IDS = ["117708948", "51516485", "60292250"];
const LYRICS_PROBE_IDS = ["51516485", "60292250", "330765"];

type AccountAbout = { geoRegionIso?: string; userSessionRegionIso?: string };

async function readAccountAbout(lib: LibClient): Promise<AccountAbout | null> {
  try {
    const raw = await lib.request.get("https://api.music.yandex.net/account/about");
    if (!raw || typeof raw !== "object") return null;
    const data = raw as Record<string, unknown>;
    return {
      geoRegionIso: typeof data.geoRegionIso === "string" ? data.geoRegionIso : undefined,
      userSessionRegionIso: typeof data.userSessionRegionIso === "string" ? data.userSessionRegionIso : undefined,
    };
  } catch {
    // /account/about не критичен для health: регион — только пояснение
    return null;
  }
}

function firstHistoryTrackId(
  history: {
    historyTabs?: Array<{ items?: Array<{ tracks?: Array<{ data?: { itemId?: { trackId?: string } } }> }> }>;
  } | null,
): string | null {
  for (const tab of history?.historyTabs ?? []) {
    for (const group of tab.items ?? []) {
      for (const item of group.tracks ?? []) {
        const id = item.data?.itemId?.trackId;
        if (id) return id;
      }
    }
  }
  return null;
}

function probeTrackFrom(track: {
  id?: string | number;
  title?: string;
  artists?: Array<{ name?: string }>;
}): YandexProbeTrack | null {
  if (track.id === undefined || track.id === null) return null;
  const artist = (track.artists ?? [])
    .map((a) => a.name)
    .filter((name): name is string => Boolean(name))
    .join(", ");
  return {
    id: bareTrackId(track.id),
    title: track.title || "без названия",
    artist: artist || "неизвестен",
  };
}

/** доступ пробы к внутренностям YandexClient: rate-gate, общий lib и производный health-lib. */
export interface HealthProbeDeps {
  gate: AsyncTokenGate;
  getLib(): Promise<LibClient>;
  healthLibFor(lib: LibClient): LibClient;
}

/** Полный read-only health-отчёт Яндекс Музыки.
 *
 * Всё, что может сломаться в проде: OAuth/аккаунт, поиск, каталог,
 * lossy/lossless-загрузка, CDN, лирика, лайки, история. Ynison проверяется
 * отдельно в services/yandexHealth.ts (watcher или активный probe).
 * Никаких мутаций (playAudio/like) — только чтение. */
export async function probeApiHealth(deps: HealthProbeDeps, opts: ApiHealthProbeOptions): Promise<YandexHealthReport> {
  const startedAt = performance.now();
  const timeoutMs = opts.timeoutMs ?? 6_000;
  const checks: YandexHealthCheck[] = [];
  let probeTrack: YandexProbeTrack | null = null;

  const finish = (): YandexHealthReport => {
    const sorted = sortHealthChecks(checks);
    return {
      checkedAt: Date.now(),
      durationMs: Math.round(performance.now() - startedAt),
      overall: overallFromChecks(sorted),
      probeTrack,
      checks: sorted,
    };
  };

  const addSkip = (key: string, label: string, critical: boolean, detail: string): void => {
    checks.push({ key, label, critical, status: "skip", latencyMs: null, detail });
  };

  const probe = async <T>(
    key: string,
    label: string,
    critical: boolean,
    fn: () => Promise<T>,
    describe: (value: T) => string,
  ): Promise<T | null> => {
    const checkStarted = performance.now();
    let requestStarted = checkStarted;
    try {
      // ждём rate-gate отдельно: его очередь не должна съедать per-check
      // таймаут реального запроса (иначе поздние проверки ложно падают)
      await deps.gate.acquire();
      requestStarted = performance.now();
      const value = await withTimeout(fn(), timeoutMs, key);
      checks.push({
        key,
        label,
        critical,
        status: "ok",
        latencyMs: Math.round(performance.now() - requestStarted),
        detail: describe(value),
      });
      return value;
    } catch (e) {
      checks.push({
        key,
        label,
        critical,
        status: "fail",
        latencyMs: Math.round(performance.now() - requestStarted),
        detail: errorDetail(e),
      });
      return null;
    }
  };

  const authStarted = performance.now();
  let lib: LibClient;
  try {
    lib = deps.healthLibFor(await withTimeout(deps.getLib(), timeoutMs, "health-auth"));
  } catch (e) {
    checks.push({
      key: "auth",
      label: "аккаунт / OAuth",
      critical: true,
      status: "fail",
      latencyMs: Math.round(performance.now() - authStarted),
      detail: errorDetail(e),
    });
    for (const dep of HEALTH_DEPENDENT) addSkip(dep.key, dep.label, dep.critical, "не проверено: нет авторизации");
    return finish();
  }

  try {
    const [me, about] = await withTimeout(
      Promise.all([lib.accountStatus(), readAccountAbout(lib)]),
      timeoutMs,
      "health-account",
    );
    const serviceAvailable = me !== null && me.account?.serviceAvailable !== false;
    let detail = serviceAvailable ? `сервис доступен${me.plus?.hasPlus ? ", Plus активен" : ""}` : "токен не принят";
    if (serviceAvailable && about?.geoRegionIso) {
      const geo = about.geoRegionIso.toUpperCase();
      const session = about.userSessionRegionIso?.toUpperCase();
      detail += `; регион ${geo}${session && session !== geo ? `, сессия ${session}` : ""}`;
    }
    checks.push({
      key: "auth",
      label: "аккаунт / OAuth",
      critical: true,
      status: serviceAvailable ? "ok" : "fail",
      latencyMs: Math.round(performance.now() - authStarted),
      detail,
    });
    if (!serviceAvailable) {
      for (const dep of HEALTH_DEPENDENT) addSkip(dep.key, dep.label, dep.critical, "не проверено: токен не принят");
      return finish();
    }
  } catch (e) {
    checks.push({
      key: "auth",
      label: "аккаунт / OAuth",
      critical: true,
      status: "fail",
      latencyMs: Math.round(performance.now() - authStarted),
      detail: errorDetail(e),
    });
    for (const dep of HEALTH_DEPENDENT)
      addSkip(dep.key, dep.label, dep.critical, "не проверено: авторизация не прошла");
    return finish();
  }

  const searchResult = await probe(
    "search",
    "поиск",
    true,
    async () => lib.search("Daft Punk", false, "track"),
    (r) => {
      const n = (r?.tracks?.results ?? []).length;
      return n > 0 ? `поиск отвечает, найдено ${n}` : "поиск отвечает, результатов нет";
    },
  );

  let catalogTrackId: string | null = null;
  if (opts.probeTrackId != null) catalogTrackId = bareTrackId(opts.probeTrackId);
  if (!catalogTrackId) {
    const first = (searchResult?.tracks?.results ?? [])[0] as { id?: string | number } | undefined;
    if (first?.id != null) catalogTrackId = bareTrackId(first.id);
  }
  if (!catalogTrackId) {
    try {
      const history = await lib.musicHistory(0);
      catalogTrackId = firstHistoryTrackId(history as any);
    } catch {
      /* ignore */
    }
  }

  if (catalogTrackId) {
    await probe(
      "catalog",
      "каталог / треки",
      true,
      async () => {
        const tracks = await lib.tracks([catalogTrackId!]);
        if (!tracks || tracks.length === 0) throw new Error("трек не найден");
        return tracks[0];
      },
      (t) => {
        probeTrack = probeTrackFrom(t as any);
        return probeTrack ? `трек доступен: ${probeTrack.artist} — ${probeTrack.title}` : "трек доступен";
      },
    );
  } else {
    addSkip("catalog", "каталог / треки", true, "не удалось выбрать пробный трек");
  }

  // lossy download
  let lossyLink: string | null = null;
  const lossyTrackId = catalogTrackId;
  if (lossyTrackId) {
    const infos = await probe(
      "download_lossy",
      "загрузка mp3/aac",
      true,
      async () => {
        const arr = (await lib.tracksDownloadInfo(lossyTrackId)) as unknown as LibDownloadInfo[];
        if (!arr || arr.length === 0) throw new Error("нет вариантов загрузки");
        return arr;
      },
      (arr) => {
        const best = selectDownloadInfo(arr as any, "best");
        return best ? `вариант: ${best.codec} ${best.bitrateInKbps}kbps` : `вариантов: ${arr.length}`;
      },
    );
    if (infos) {
      const chosen = selectDownloadInfo(infos as any, "best") as unknown as LibDownloadInfo | null;
      if (chosen) {
        try {
          chosen.directLink = undefined;
          lossyLink = await chosen.getDirectLink();
        } catch {
          lossyLink = null;
        }
      }
    }
  } else {
    addSkip("download_lossy", "загрузка mp3/aac", true, "не удалось выбрать пробный трек");
  }

  // lossless: перебираем эталонные id, пока кто-то не отдаст настоящий lossless;
  // lossy-ответ (нет Plus / нет lossless-источника) — degraded, а не ok
  let losslessLink: string | null = null;
  let losslessCodec: string | null = null;
  const info = await probe(
    "download_lossless",
    "lossless / get-file-info",
    true,
    async () => {
      let lossy: LibLosslessDownloadInfo | null = null;
      let lastError: unknown = new Error("нет lossless-инфо");
      for (const id of LOSSLESS_PROBE_IDS) {
        try {
          const i = (await lib.tracksFileInfo(id, { quality: "lossless" }))?.downloadInfo;
          if (!i) continue;
          if (isLosslessInfo(i)) return i;
          lossy ??= i;
        } catch (e) {
          lastError = e;
        }
      }
      if (lossy) return lossy;
      throw lastError;
    },
    (i) => (isLosslessInfo(i) ? `lossless доступен: ${i.codec}` : `ответ получен: ${i.codec}`),
  );
  if (info) {
    losslessLink = info.links()[0] ?? null;
    losslessCodec = info.codec ?? null;
    if (!isLosslessInfo(info)) {
      // критичная проверка не должна быть ok при lossy-ответе: понижаем до некритичной ошибки → overall degraded
      const check = checks.find((c) => c.key === "download_lossless");
      if (check) {
        check.status = "fail";
        check.critical = false;
        check.detail = `lossless недоступен, отдан ${info.codec ?? "?"}`;
      }
      losslessLink = null;
    }
  }

  // CDN probe: для lossless — Range первых байт + проверка контейнера
  const cdnUrl = losslessLink || lossyLink;
  if (cdnUrl) {
    await probe(
      "cdn",
      "CDN",
      true,
      async () => {
        if (losslessLink) {
          const res = await opts.http.request(losslessLink, {
            headers: { Range: `bytes=0-${AUDIO_MAGIC_BYTES - 1}` },
          });
          let head: Buffer = Buffer.alloc(0);
          try {
            if (res.status >= 400) throw new Error(`CDN ответ ${res.status}`);
            for await (const chunk of res.body) {
              head = Buffer.from(chunk as Uint8Array);
              break;
            }
          } finally {
            res.body.destroy();
          }
          assertAudioMagic(head, losslessCodec);
          return res;
        }
        const res = await opts.http.headOrRange(cdnUrl, 0, 0);
        if (!res || res.status >= 400) throw new Error(`CDN ответ ${res?.status ?? "?"}`);
        return res;
      },
      () => (losslessLink ? "lossless CDN отвечает, контейнер корректен" : "CDN отвечает"),
    );
  } else {
    addSkip("cdn", "CDN", true, "нет ссылки для проверки");
  }

  // lyrics
  const lyricsId = LYRICS_PROBE_IDS[0] || catalogTrackId;
  if (lyricsId) {
    await probe(
      "lyrics",
      "лирика",
      false,
      async () => {
        const lyrics = await lib.tracksLyrics(lyricsId, "LRC");
        if (!lyrics) throw new Error("нет лирики");
        const text = await lyrics.fetchLyrics();
        if (!text) throw new Error("пустой текст лирики");
        return text;
      },
      (text) => `лирика доступна, ${String(text).length} символов`,
    );
  } else {
    addSkip("lyrics", "лирика", false, "нет пробного трека");
  }

  // likes
  await probe(
    "likes",
    "лайки",
    false,
    async () => lib.usersLikesTracks(),
    (libRes) => `лайки доступны${(libRes as any)?.tracks ? `, ${(libRes as any).tracks.length} треков` : ""}`,
  );

  // history
  await probe(
    "history",
    "история",
    false,
    async () => lib.musicHistory(0),
    (h) => {
      const tabs = (h as any)?.historyTabs?.length ?? 0;
      return tabs > 0 ? `история доступна, вкладок ${tabs}` : "история доступна";
    },
  );

  return finish();
}
