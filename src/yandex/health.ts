export type YandexHealthStatus = "ok" | "fail" | "skip";
export type YandexOverallStatus = "ok" | "degraded" | "fail";

export interface YandexHealthCheck {
  key: string;
  label: string;
  critical: boolean;
  status: YandexHealthStatus;
  latencyMs: number | null;
  detail: string;
}

export interface YandexProbeTrack {
  id: string;
  title: string;
  artist: string;
}

export interface YandexHealthReport {
  checkedAt: number;
  durationMs: number;
  overall: YandexOverallStatus;
  probeTrack: YandexProbeTrack | null;
  checks: YandexHealthCheck[];
}

const CHECK_ORDER = [
  "auth",
  "search",
  "catalog",
  "download_lossy",
  "download_lossless",
  "cdn",
  "lyrics",
  "likes",
  "history",
  "ynison",
];

export function sortHealthChecks(checks: YandexHealthCheck[]): YandexHealthCheck[] {
  const order = new Map(CHECK_ORDER.map((k, i) => [k, i]));
  return [...checks].sort((a, b) => (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999));
}

export function overallFromChecks(checks: YandexHealthCheck[]): YandexOverallStatus {
  let degraded = false;
  for (const c of checks) {
    if (c.status === "fail") {
      if (c.critical) return "fail";
      degraded = true;
    }
  }
  return degraded ? "degraded" : "ok";
}

export function errorDetail(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
