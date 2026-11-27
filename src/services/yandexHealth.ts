/** Сбор и рендер health-панели Яндекс Музыки для админского /health. */
import { bold, type FormatResult, format, join } from "yaebal";
import type { Container } from "../bot/container.ts";
import { getSettings } from "../settings.ts";
import {
  errorDetail,
  overallFromChecks,
  sortHealthChecks,
  type YandexHealthCheck,
  type YandexHealthReport,
} from "../yandex/health.ts";

const HEALTH_CACHE_TTL_MS = 4_000;

const CHECK_META: Record<string, { label: string; critical: boolean }> = {
  auth: { label: "аккаунт / OAuth", critical: true },
  search: { label: "поиск", critical: true },
  catalog: { label: "каталог / треки", critical: true },
  download_lossy: { label: "загрузка mp3/aac", critical: true },
  download_lossless: { label: "lossless / get-file-info", critical: true },
  cdn: { label: "CDN", critical: true },
  lyrics: { label: "лирика", critical: false },
  likes: { label: "лайки", critical: false },
  history: { label: "история", critical: false },
  ynison: { label: "Ynison", critical: true },
};

let cachedReport: YandexHealthReport | null = null;
let cachedAt = 0;
let inflight: Promise<YandexHealthReport> | null = null;

/** Короткий кэш + дедуп: повторные тапы по кнопке не устраивают шквал запросов. */
export async function getYandexHealth(container: Container, force = false): Promise<YandexHealthReport> {
  if (!force && cachedReport !== null && Date.now() - cachedAt < HEALTH_CACHE_TTL_MS) return cachedReport;
  if (inflight !== null) return inflight;

  inflight = collectHealth(container)
    .then((report) => {
      cachedReport = report;
      cachedAt = Date.now();
      return report;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** для тестов: сбросить модульный кэш между кейсами. */
export function resetYandexHealthCache(): void {
  cachedReport = null;
  cachedAt = 0;
  inflight = null;
}

function skippedReport(detail: string, authStatus: "fail" | "skip"): YandexHealthReport {
  const checks: YandexHealthCheck[] = Object.entries(CHECK_META).map(([key, meta]) => ({
    key,
    label: meta.label,
    critical: meta.critical,
    status: key === "auth" ? authStatus : "skip",
    latencyMs: null,
    detail,
  }));
  return {
    checkedAt: Date.now(),
    durationMs: 0,
    overall: overallFromChecks(checks),
    probeTrack: null,
    checks: sortHealthChecks(checks),
  };
}

async function collectHealth(container: Container): Promise<YandexHealthReport> {
  const ownerId = getSettings().OWNER_ID;
  if (!ownerId) return skippedReport("OWNER_ID=0 — Яндекс Музыка не настроена", "skip");

  let token: string | null;
  try {
    token = await container.resolveToken(ownerId);
  } catch (e) {
    const report = skippedReport(`не удалось получить токен: ${errorDetail(e)}`, "fail");
    return report;
  }
  if (token === null) return skippedReport("нет сохранённого токена владельца", "fail");

  let yandex: Awaited<ReturnType<Container["getYandexService"]>>;
  try {
    yandex = await container.getYandexService(token, ownerId);
  } catch (e) {
    return skippedReport(`не удалось создать клиент: ${errorDetail(e)}`, "fail");
  }

  const snapshot = container.npWatcher?.health().hasTrack ? container.npWatcher.getCurrentSnapshot() : null;
  const probeTrackId = snapshot?.track?.id ?? null;

  const report = await yandex.probeApiHealth({
    http: container.httpClient,
    probeTrackId,
    timeoutMs: 6_000,
  });

  const authOk = report.checks.find((c) => c.key === "auth")?.status === "ok";
  const ynison = authOk
    ? await probeYnison(container, yandex)
    : {
        key: "ynison",
        label: CHECK_META.ynison!.label,
        critical: true,
        status: "skip" as const,
        latencyMs: null,
        detail: "не проверено: авторизация не прошла",
      };
  const checks = sortHealthChecks([...report.checks, ynison]);
  await enrichAuthCheck(container, ownerId, checks);

  return {
    ...report,
    overall: overallFromChecks(checks),
    checks,
  };
}

export async function probeYnison(
  container: Container,
  yandex: Awaited<ReturnType<Container["getYandexService"]>>,
): Promise<YandexHealthCheck> {
  const startedAt = performance.now();
  const watcher = container.npWatcher?.health() ?? null;
  const base = {
    key: "ynison",
    label: CHECK_META.ynison!.label,
    critical: true,
  };

  if (watcher?.running && watcher.connected) {
    const detail =
      watcher.lastStateAgeMs === null
        ? "watcher подключён, кадров ещё не было"
        : `watcher подключён, кадр ${Math.round(watcher.lastStateAgeMs / 1000)}с назад`;
    return {
      ...base,
      status: "ok",
      latencyMs: Math.round(performance.now() - startedAt),
      detail,
    };
  }

  // watcher молчит — спрашиваем сам Ynison, а не угадываем по локальному флагу.
  // Так в панели видно, лежит ли сервис или сломался только watcher.
  try {
    const probe = await yandex.probeYnison();
    return {
      ...base,
      status: watcher?.running ? "fail" : "ok",
      latencyMs: Math.round(performance.now() - startedAt),
      detail: watcher?.running
        ? `Ynison отвечает (${probe.detail}), но watcher не подключён`
        : `live probe: ${probe.detail}`,
    };
  } catch (e) {
    return {
      ...base,
      status: "fail",
      latencyMs: Math.round(performance.now() - startedAt),
      detail: watcher?.running
        ? `Ynison недоступен: ${errorDetail(e)}; watcher не подключён`
        : `Ynison недоступен: ${errorDetail(e)}`,
    };
  }
}

function tokenLifetime(leftSec: number): string {
  if (leftSec <= 0) return "истёк";
  if (leftSec >= 2 * 86_400) return `ещё ${Math.ceil(leftSec / 86_400)} дн`;
  if (leftSec >= 2 * 3_600) return `ещё ${Math.ceil(leftSec / 3_600)} ч`;
  return `ещё ${Math.ceil(leftSec / 60)} мин`;
}

/** добавляет к auth-строке срок жизни токена, не раскрывая uid/логин/сам токен. */
async function enrichAuthCheck(container: Container, ownerId: number, checks: YandexHealthCheck[]): Promise<void> {
  const auth = checks.find((c) => c.key === "auth");
  if (auth?.status !== "ok") return;
  try {
    const creds = await container.usersDb.get(ownerId);
    if (!creds) return;
    let tokenInfo = "срок не указан";
    if (creds.expires_at != null) {
      tokenInfo = tokenLifetime(Math.round(creds.expires_at - Date.now() / 1000));
    }
    auth.detail += `; токен ${tokenInfo}${creds.refresh_token ? ", refresh есть" : ", без refresh"}`;
  } catch (e) {
    auth.detail += `; не удалось прочитать срок токена: ${errorDetail(e)}`;
  }
}

function statusIcon(check: YandexHealthCheck): string {
  if (check.status === "ok") return "✅";
  if (check.status === "skip") return "⏭️";
  return check.critical ? "❌" : "⚠️";
}

function overallLabel(report: YandexHealthReport): string {
  if (report.overall === "ok") return "всё ок";
  if (report.overall === "degraded") return "есть проблемы";
  return "критично";
}

function overallIcon(report: YandexHealthReport): string {
  if (report.overall === "ok") return "✅";
  if (report.overall === "degraded") return "⚠️";
  return "❌";
}

function latency(ms: number | null): string {
  if (ms === null) return "";
  return ms >= 1000 ? ` · ${(ms / 1000).toFixed(1)}с` : ` · ${Math.round(ms)}мс`;
}

function oneLine(text: string, maxLen = 120): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

/** FormatResult: без parse_mode, только telegram-entities. */
export function formatYandexHealth(report: YandexHealthReport): FormatResult {
  const lines = report.checks.map(
    (check) => format`${statusIcon(check)} ${check.label}: ${oneLine(check.detail)}${latency(check.latencyMs)}`,
  );
  const probe = report.probeTrack;
  const trackLine = probe ? format`\n🎵 пробный трек: ${oneLine(`${probe.artist} — ${probe.title}`, 70)}` : "";
  const time = new Date(report.checkedAt).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return format`🎵 ${bold("Яндекс Музыка")} · ${overallIcon(report)} ${overallLabel(report)}
${join(lines, "\n")}
${trackLine}

🕒 ${time} · проверка ${report.durationMs}мс`;
}
