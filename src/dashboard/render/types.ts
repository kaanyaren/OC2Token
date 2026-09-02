import type {
  CollectionResult,
  StoredSnapshot,
  TokenComponents,
  UsageTotals,
  UsageWindow,
  UsageWindowKind,
} from "../../domain/index.js";

export type DateLike = Date | string | number;

export interface CoverageView {
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

export interface TrendBucket {
  readonly label: string;
  readonly totals: UsageTotals;
  readonly from?: DateLike;
  readonly to?: DateLike;
}

export interface BreakdownTotal {
  readonly name: string;
  readonly provider?: string;
  readonly totals: UsageTotals;
}

export interface DashboardWindow {
  readonly window: UsageWindow;
  readonly totals: UsageTotals;
  readonly trends: ReadonlyArray<TrendBucket>;
  readonly models: ReadonlyArray<BreakdownTotal>;
  readonly providers: ReadonlyArray<BreakdownTotal>;
}

export interface DashboardSnapshot {
  readonly windows: Readonly<Record<UsageWindowKind, DashboardWindow>>;
  readonly source: string;
  readonly version: string;
  readonly lastUpdated: DateLike | null;
  readonly nextRefreshAt: DateLike | null;
  readonly stale: boolean;
  readonly coverage: CoverageView;
  readonly models: ReadonlyArray<BreakdownTotal>;
  readonly providers: ReadonlyArray<BreakdownTotal>;
}

export type DashboardSnapshotInput =
  | CollectionResult
  | StoredSnapshot
  | DashboardSnapshot
  | Readonly<Record<string, unknown>>;

export interface DashboardRenderOptions {
  readonly ansi?: boolean;
  readonly isTTY?: boolean;
  readonly color?: boolean;
  readonly width?: number;
  readonly now?: DateLike;
  readonly selectedWindow?: UsageWindowKind;
  readonly help?: boolean;
  readonly previousLineCount?: number;
}

export interface OutputOptions extends DashboardRenderOptions {
  readonly format?: "auto" | "dashboard" | "table" | "json";
  readonly prettyJson?: boolean;
}

type UnknownRecord = Record<string, unknown>;

const WINDOW_KINDS = ["hour", "day", "week"] as const;
const COMPONENTS = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asDate(value: unknown): DateLike | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function tokenInput(value: unknown): UnknownRecord {
  const record = asRecord(value);
  const cache = asRecord(record.cache);
  return {
    input: record.input,
    output: record.output,
    reasoning: record.reasoning,
    cacheRead: record.cacheRead ?? cache.read,
    cacheWrite: record.cacheWrite ?? cache.write,
  };
}

function totalsFor(value: unknown): UsageTotals {
  const input = tokenInput(value);
  const components: TokenComponents = {
    input: asCount(input.input),
    output: asCount(input.output),
    reasoning: asCount(input.reasoning),
    cacheRead: asCount(input.cacheRead),
    cacheWrite: asCount(input.cacheWrite),
  };
  const recorded_total = COMPONENTS.reduce((sum, name) => sum + components[name], 0);
  return { ...components, recorded_total };
}

function dateForWindow(value: unknown, fallback: Date): Date {
  const date = asDate(value);
  return date === null ? new Date(fallback.getTime()) : new Date(date);
}

function fallbackWindow(kind: UsageWindowKind, timezone: string): UsageWindow {
  const now = new Date(0);
  const from = new Date(kind === "hour" ? -60 * 60 * 1000 : 0);
  const to = kind === "hour" ? now : new Date(60 * 60 * 1000);
  return {
    kind,
    semantics: kind === "hour" ? "rolling-hour" : kind === "day" ? "local-day" : "iso-week",
    timezone,
    from,
    to,
    label: kind === "hour" ? "last 60 minutes" : kind === "day" ? "today" : "this week",
    ...(kind === "day" ? { localDate: "1970-01-01" } : {}),
    ...(kind === "week" ? { isoWeekYear: 1970, isoWeek: 1, isoWeekLabel: "1970-W01" } : {}),
  } as UsageWindow;
}

function normalizeWindow(kind: UsageWindowKind, value: unknown, timezone: string): UsageWindow {
  const source = asRecord(value);
  const fallback = fallbackWindow(kind, timezone);
  const from = dateForWindow(source.from, fallback.from);
  const to = dateForWindow(source.to, fallback.to);
  const common = {
    kind,
    semantics: asString(source.semantics, fallback.semantics),
    timezone: asString(source.timezone, timezone),
    from,
    to,
    label: asString(source.label, fallback.label),
  };
  if (kind === "day") {
    return {
      ...common,
      kind,
      semantics: "local-day",
      localDate: asString(source.localDate, asString(source.label, "today")),
    } as UsageWindow;
  }
  if (kind === "week") {
    return {
      ...common,
      kind,
      semantics: "iso-week",
      isoWeekYear: asCount(source.isoWeekYear) || 1970,
      isoWeek: asCount(source.isoWeek) || 1,
      isoWeekLabel: asString(source.isoWeekLabel, asString(source.label, "1970-W01")),
    } as UsageWindow;
  }
  return { ...common, kind, semantics: "rolling-hour" } as UsageWindow;
}

function normalizeTrend(value: unknown): TrendBucket | null {
  const source = asRecord(value);
  const label = asString(source.label ?? source.name ?? source.bucket, "");
  if (!label) return null;
  return {
    label,
    totals: totalsFor(source.totals ?? source.usage ?? source),
    ...(source.from === undefined ? {} : { from: asDate(source.from) ?? undefined }),
    ...(source.to === undefined ? {} : { to: asDate(source.to) ?? undefined }),
  };
}

function normalizeTrends(value: unknown): ReadonlyArray<TrendBucket> {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeTrend).filter((item): item is TrendBucket => item !== null);
}

function normalizeBreakdown(value: unknown): ReadonlyArray<BreakdownTotal> {
  if (!Array.isArray(value)) return [];
  const result: BreakdownTotal[] = [];
  for (const item of value) {
    const source = asRecord(item);
    const name = asString(source.name ?? source.model ?? source.provider ?? source.key, "");
    if (!name) continue;
    const provider = asOptionalString(source.provider);
    result.push({
      name,
      ...(provider === undefined ? {} : { provider }),
      totals: totalsFor(source.totals ?? source.usage ?? source),
    });
  }
  return result.sort((left, right) =>
    right.totals.recorded_total - left.totals.recorded_total ||
    left.name.localeCompare(right.name) ||
    (left.provider ?? "").localeCompare(right.provider ?? ""),
  );
}

function normalizeCoverage(value: unknown, stale: boolean): CoverageView {
  const source = asRecord(value);
  const errors = Array.isArray(source.errors)
    ? source.errors.map((item) => {
        const error = asRecord(item);
        return {
          code: asString(error.code, "unknown"),
          ...(asOptionalString(error.sessionID) === undefined
            ? {}
            : { sessionID: asOptionalString(error.sessionID) }),
          retryable: error.retryable === true,
        };
      })
    : [];
  return {
    complete: stale ? false : source.complete === true,
    sessionsDiscovered: asCount(source.sessionsDiscovered),
    sessionsScanned: asCount(source.sessionsScanned),
    sessionsSkipped: asCount(source.sessionsSkipped),
    pagesRead: asCount(source.pagesRead),
    jobsRetried: asCount(source.jobsRetried),
    provisionalMessages: asCount(source.provisionalMessages),
    errors,
  };
}

function readWindowData(root: UnknownRecord, kind: UsageWindowKind): UnknownRecord {
  const windows = Array.isArray(root.windows)
    ? root.windows.find((value) => asRecord(value).kind === kind)
    : asRecord(root.windows)[kind];
  const candidate = asRecord(windows);
  const collection = asRecord(root.windowData);
  const collectionCandidate = asRecord(collection[kind]);
  return Object.keys(candidate).length > 0 ? candidate : collectionCandidate;
}

function readTotals(root: UnknownRecord, kind: UsageWindowKind, data: UnknownRecord): UsageTotals {
  const totals = asRecord(root.totals);
  const usage = asRecord(root.usage);
  const windowTotals = asRecord(root.windowTotals ?? root.totalsByWindow);
  return totalsFor(
    data.totals ??
    totals[kind] ??
    usage[kind] ??
    windowTotals[kind] ??
    data,
  );
}

function sourceAndVersion(root: UnknownRecord): { source: string; version: string } {
  const sourceValue = root.source;
  const sourceObject = asRecord(sourceValue);
  const source = typeof sourceValue === "string"
    ? sourceValue
    : asString(sourceObject.kind ?? sourceObject.name ?? sourceObject.type, "unknown");
  return {
    source,
    version: asString(root.version ?? root.serverVersion ?? sourceObject.version, "unknown"),
  };
}

function bucketLabel(date: Date, timezone: string, kind: UsageWindowKind): string {
  try {
    return new Intl.DateTimeFormat("en-CA", kind === "week"
      ? { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }
      : { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
    ).format(date);
  } catch {
    return date.toISOString();
  }
}

function deriveTrends(
  root: UnknownRecord,
  kind: UsageWindowKind,
  window: UsageWindow,
): ReadonlyArray<TrendBucket> {
  if (!Array.isArray(root.records)) return [];
  const duration = window.to.getTime() - window.from.getTime();
  const bucketDuration = kind === "hour"
    ? 15 * 60 * 1000
    : kind === "day"
      ? 60 * 60 * 1000
      : 24 * 60 * 60 * 1000;
  const bucketCount = Math.max(1, Math.min(24, Math.ceil(duration / bucketDuration)));
  const values = Array.from({ length: bucketCount }, (_, index) => {
    const from = new Date(window.from.getTime() + index * bucketDuration);
    const to = new Date(Math.min(window.to.getTime(), from.getTime() + bucketDuration));
    return {
      label: bucketLabel(from, window.timezone, kind),
      from,
      to,
      totals: {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        recorded_total: 0,
      },
    };
  });

  for (const item of root.records) {
    const record = asRecord(item);
    if (record.completeness === "provisional") continue;
    const createdAt = asDate(record.createdAt ?? record.time);
    if (createdAt === null || !(createdAt instanceof Date)) continue;
    const timestamp = createdAt.getTime();
    if (timestamp < window.from.getTime() || timestamp >= window.to.getTime()) continue;
    const index = Math.min(
      values.length - 1,
      Math.max(0, Math.floor((timestamp - window.from.getTime()) / bucketDuration)),
    );
    const next = totalsFor(record);
    const current = values[index].totals;
    for (const component of COMPONENTS) current[component] += next[component];
    current.recorded_total += next.recorded_total;
  }
  return values;
}

function recordsAsBreakdown(
  root: UnknownRecord,
  key: "model" | "provider",
  window?: UsageWindow,
): ReadonlyArray<BreakdownTotal> {
  if (!Array.isArray(root.records)) return [];
  const totals = new Map<string, TokenComponents>();
  for (const item of root.records) {
    const record = asRecord(item);
    if (record.completeness === "provisional") continue;
    if (window !== undefined) {
      const createdAt = asDate(record.createdAt ?? record.time);
      if (createdAt === null) continue;
      const timestamp = new Date(createdAt).getTime();
      if (!Number.isFinite(timestamp) || timestamp < window.from.getTime() || timestamp >= window.to.getTime()) continue;
    }
    const model = asOptionalString(record.model);
    const name = asOptionalString(record[key]) ??
      (key === "provider" && model?.includes("/") ? model.split("/", 1)[0] : undefined);
    if (!name) continue;
    const current: {
      input: number;
      output: number;
      reasoning: number;
      cacheRead: number;
      cacheWrite: number;
    } = totals.get(name) ?? {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    const next = totalsFor(record);
    for (const component of COMPONENTS) current[component] += next[component];
    totals.set(name, current);
  }
  return normalizeBreakdown(
    [...totals.entries()].map(([name, value]) => ({ name, ...value })),
  );
}

function breakdownForWindow(
  root: UnknownRecord,
  key: "model" | "provider",
  kind: UsageWindowKind,
  window: UsageWindow,
): ReadonlyArray<BreakdownTotal> {
  const byWindow = asRecord(root[key === "model" ? "modelsByWindow" : "providersByWindow"]);
  const scoped = byWindow[kind];
  if (Array.isArray(scoped)) return normalizeBreakdown(scoped);

  const global = key === "model"
    ? root.models ?? root.modelTotals ?? asRecord(root.breakdown).models
    : root.providers ?? root.providerTotals ?? asRecord(root.breakdown).providers;
  if (Array.isArray(global)) return normalizeBreakdown(global);

  // Message scans carry individual records rather than stats aggregates, so
  // derive the selected window directly from record creation timestamps.
  if (Array.isArray(root.records) && root.records.length > 0) {
    return recordsAsBreakdown(root, key, window);
  }

  return normalizeBreakdown(global);
}

/**
 * Normalize the collector's shared-domain snapshot into the renderer's read-only
 * view. The renderer intentionally reads only metadata and token aggregates.
 */
export function normalizeDashboardSnapshot(input: DashboardSnapshotInput): DashboardSnapshot {
  const root = asRecord(input);
  const metadata = asRecord(root.metadata);
  const requestedWindows = Array.isArray(root.requestedWindows) ? root.requestedWindows : root.windows;
  const timezone = asString(
    root.timezone ??
      metadata.timezone ??
      (Array.isArray(requestedWindows) ? asRecord(requestedWindows[0]).timezone : undefined),
    "UTC",
  );
  const stale = root.stale === true;
  const sourceVersion = sourceAndVersion(root);
  const rootTrends = asRecord(root.trends);
  const windows = {} as Record<UsageWindowKind, DashboardWindow>;

  for (const kind of WINDOW_KINDS) {
    const windowData = readWindowData(root, kind);
    const requestedWindow = Array.isArray(requestedWindows)
      ? requestedWindows.find((value) => asRecord(value).kind === kind)
      : undefined;
    const window = normalizeWindow(
      kind,
      requestedWindow ?? windowData.window ?? windowData,
      timezone,
    );
    const trends = normalizeTrends(
      windowData.trends ??
      (Array.isArray(rootTrends[kind]) ? rootTrends[kind] : undefined),
    );
    const models = breakdownForWindow(root, "model", kind, window);
    const providers = breakdownForWindow(root, "provider", kind, window);
    windows[kind] = {
      window,
      totals: readTotals(root, kind, windowData),
      trends: trends.length > 0 ? trends : deriveTrends(root, kind, window),
      models,
      providers,
    };
  }

  const coverage = normalizeCoverage(root.coverage, stale);
  const modelValues =
    root.models ??
    root.modelTotals ??
    asRecord(root.breakdown).models ??
    windows.week.models;
  const providerValues =
    root.providers ??
    root.providerTotals ??
    asRecord(root.breakdown).providers ??
    windows.week.providers;
  return {
    windows,
    source: sourceVersion.source,
    version: sourceVersion.version,
    lastUpdated: asDate(root.lastUpdated ?? metadata.lastUpdated ?? root.capturedAt),
    nextRefreshAt: asDate(root.nextRefreshAt ?? metadata.nextRefreshAt),
    stale,
    coverage,
    models: normalizeBreakdown(modelValues),
    providers: normalizeBreakdown(providerValues),
  };
}

export function usageTotalsFrom(value: unknown): UsageTotals {
  return totalsFor(value);
}

export function allWindowKinds(): readonly UsageWindowKind[] {
  return WINDOW_KINDS;
}
