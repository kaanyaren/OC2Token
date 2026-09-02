import type { DateLike, CoverageView } from "./types.js";

const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "");
}

/** Remove terminal controls and line breaks before displaying untrusted metadata. */
export function safeLabel(value: unknown, maxLength = 80): string {
  const normalized = stripAnsi(String(value ?? ""))
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd() + "…";
}

export function safeIdentifier(value: unknown, maxLength = 64): string {
  return safeLabel(value, maxLength).replace(/[^\p{L}\p{N}._:@+\/-]/gu, "_");
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  const rounded = Math.round(value);
  if (rounded < 1_000) return String(rounded);
  const units = ["K", "M", "B", "T"];
  let unit = -1;
  let scaled = rounded;
  while (scaled >= 1_000 && unit < units.length - 1) {
    scaled /= 1_000;
    unit += 1;
  }
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 1;
  const formatted = scaled.toFixed(decimals).replace(/\.0$/, "");
  return formatted + units[unit];
}

export function formatExactTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  return Math.round(value).toLocaleString("en-US");
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return "--:--";
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function validDate(value: DateLike | null | undefined): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export function formatTimestamp(value: DateLike | null | undefined, timezone = "UTC"): string {
  const date = validDate(value);
  if (date === null) return "—";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(date).replace(",", "");
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(date).replace(",", "");
  }
}

export function formatShortTimestamp(value: DateLike | null | undefined, timezone = "UTC"): string {
  const date = validDate(value);
  if (date === null) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(date).replace(",", "");
  } catch {
    return formatShortTimestamp(value, "UTC");
  }
}

export function formatWindowRange(from: DateLike, to: DateLike, timezone: string): string {
  return `${formatTimestamp(from, timezone)} → ${formatTimestamp(to, timezone)}`;
}

export function coverageState(coverage: CoverageView, stale: boolean): "complete" | "partial" | "stale" {
  if (stale) return "stale";
  return coverage.complete ? "complete" : "partial";
}

export function formatCoverage(coverage: CoverageView, stale: boolean): string {
  const state = coverageState(coverage, stale).toUpperCase();
  const sessions = `${coverage.sessionsScanned}/${coverage.sessionsDiscovered} sessions`;
  const errors = coverage.errors.length > 0 ? ` · ${coverage.errors.length} error${coverage.errors.length === 1 ? "" : "s"}` : "";
  const provisional = coverage.provisionalMessages > 0
    ? ` · ${coverage.provisionalMessages} provisional`
    : "";
  return `${state} · ${sessions}${provisional}${errors}`;
}

export function formatTokenBreakdown(totals: {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}): string {
  return [
    `In ${formatTokenCount(totals.input)}`,
    `Out ${formatTokenCount(totals.output)}`,
    `Reason ${formatTokenCount(totals.reasoning)}`,
    `Cache R ${formatTokenCount(totals.cacheRead)}`,
    `W ${formatTokenCount(totals.cacheWrite)}`,
  ].join("  ");
}

export function formatNextRefresh(
  nextRefreshAt: DateLike | null,
  now: DateLike | null | undefined,
): string {
  const target = validDate(nextRefreshAt);
  const current = validDate(now);
  if (target === null || current === null) return "Next —";
  return target.getTime() <= current.getTime()
    ? "Refreshing…"
    : `Next ${formatDuration(target.getTime() - current.getTime())}`;
}
