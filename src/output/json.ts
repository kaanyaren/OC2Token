import type { UsageTotals, UsageWindowKind } from "../domain/index.js";
import {
  allWindowKinds,
  normalizeDashboardSnapshot,
  type BreakdownTotal,
  type CoverageView,
  type DashboardSnapshotInput,
  type DashboardWindow,
  type DateLike,
  type TrendBucket,
} from "../dashboard/render/types.js";

export const JSON_SCHEMA_VERSION = 1 as const;

export interface SerializedWindow {
  readonly kind: UsageWindowKind;
  readonly semantics: string;
  readonly timezone: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly localDate?: string;
  readonly isoWeekYear?: number;
  readonly isoWeek?: number;
  readonly isoWeekLabel?: string;
}

export interface StableCoverage {
  readonly complete: boolean;
  readonly sessionsDiscovered: number;
  readonly sessionsScanned: number;
  readonly sessionsSkipped: number;
  readonly pagesRead: number;
  readonly jobsRetried: number;
  readonly provisionalMessages: number;
  readonly errors: ReadonlyArray<{
    readonly code: string;
    readonly sessionID?: string;
    readonly retryable: boolean;
  }>;
}

export interface SerializedTrend {
  readonly label: string;
  readonly totals: UsageTotals;
  readonly from: string | null;
  readonly to: string | null;
}

export interface SerializedBreakdown {
  readonly name: string;
  readonly provider?: string;
  readonly totals: UsageTotals;
}

export interface StableJSONSnapshot {
  readonly schemaVersion: typeof JSON_SCHEMA_VERSION;
  readonly windows: Readonly<Record<UsageWindowKind, SerializedWindow>>;
  readonly source: string;
  readonly version: string;
  readonly lastUpdated: string | null;
  readonly nextRefreshAt: string | null;
  readonly stale: boolean;
  readonly coverage: StableCoverage;
  readonly totals: Readonly<Record<UsageWindowKind, UsageTotals>>;
  readonly trends: Readonly<Record<UsageWindowKind, ReadonlyArray<SerializedTrend>>>;
  readonly models: ReadonlyArray<SerializedBreakdown>;
  readonly providers: ReadonlyArray<SerializedBreakdown>;
}

function dateToISO(value: DateLike | null): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function serializeWindow(value: DashboardWindow): SerializedWindow {
  const source = value.window;
  return {
    kind: source.kind,
    semantics: source.semantics,
    timezone: source.timezone,
    from: dateToISO(source.from) ?? new Date(0).toISOString(),
    to: dateToISO(source.to) ?? new Date(0).toISOString(),
    label: source.label,
    ...(source.kind === "day" ? { localDate: source.localDate } : {}),
    ...(source.kind === "week"
      ? {
          isoWeekYear: source.isoWeekYear,
          isoWeek: source.isoWeek,
          isoWeekLabel: source.isoWeekLabel,
        }
      : {}),
  };
}

function serializeCoverage(value: CoverageView): StableCoverage {
  return {
    complete: value.complete,
    sessionsDiscovered: value.sessionsDiscovered,
    sessionsScanned: value.sessionsScanned,
    sessionsSkipped: value.sessionsSkipped,
    pagesRead: value.pagesRead,
    jobsRetried: value.jobsRetried,
    provisionalMessages: value.provisionalMessages,
    errors: value.errors.map((error) => ({
      code: error.code,
      ...(error.sessionID === undefined ? {} : { sessionID: error.sessionID }),
      retryable: error.retryable,
    })),
  };
}

function serializeTrend(value: TrendBucket): SerializedTrend {
  return {
    label: value.label,
    totals: value.totals,
    from: dateToISO(value.from ?? null),
    to: dateToISO(value.to ?? null),
  };
}

function serializeBreakdown(value: BreakdownTotal): SerializedBreakdown {
  return {
    name: value.name,
    ...(value.provider === undefined ? {} : { provider: value.provider }),
    totals: value.totals,
  };
}

/**
 * Build a stable metadata-first JSON contract. All three exact windows are
 * emitted, even when the terminal view currently focuses on one period.
 */
export function toJSONSnapshot(input: DashboardSnapshotInput): StableJSONSnapshot {
  const snapshot = normalizeDashboardSnapshot(input);
  const windows = {} as Record<UsageWindowKind, SerializedWindow>;
  const totals = {} as Record<UsageWindowKind, UsageTotals>;
  const trends = {} as Record<UsageWindowKind, ReadonlyArray<SerializedTrend>>;

  for (const kind of allWindowKinds()) {
    windows[kind] = serializeWindow(snapshot.windows[kind]);
    totals[kind] = snapshot.windows[kind].totals;
    trends[kind] = snapshot.windows[kind].trends.map(serializeTrend);
  }

  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    windows,
    source: snapshot.source,
    version: snapshot.version,
    lastUpdated: dateToISO(snapshot.lastUpdated),
    nextRefreshAt: dateToISO(snapshot.nextRefreshAt),
    stale: snapshot.stale,
    coverage: serializeCoverage(snapshot.coverage),
    totals,
    trends,
    models: snapshot.models.map(serializeBreakdown),
    providers: snapshot.providers.map(serializeBreakdown),
  };
}

export function renderJSON(input: DashboardSnapshotInput, pretty = false): string {
  return JSON.stringify(toJSONSnapshot(input), null, pretty ? 2 : undefined);
}

export const renderJson = renderJSON;
export const serializeDashboardSnapshot = toJSONSnapshot;
