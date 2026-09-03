import { homedir } from "node:os";
import { join } from "node:path";

import {
  DomainError,
  cancellationError,
  containsInstant,
  createUsageTrendBuckets,
  createUsageWindows,
  isCancellationError,
  sumUsageRecords,
  toCollectionError,
  type CollectionRequest,
  type CollectionResult,
  type CollectionError,
  type Coverage,
  type StoredSnapshot,
  type UsageSource,
  type ProviderKind,
  type CollectionSource,
  type UsageBreakdown,
  type UsageBreakdownsByWindow,
  type UsageTotals,
  type UsageTotalsByWindow,
  type UsageRecord,
  type UsageTrendBucket,
  type UsageTrendsByWindow,
  type UsageWindow,
  type UsageWindowKind,
  toUsageTotals,
} from "./domain/index.js";
import { collectUsageParallel, type CollectorOptions } from "./collector/index.js";
import { UsageRecordReducer } from "./accounting/reducer.js";
import { collectCodex } from "./codex/index.js";
import { collectAntigravity } from "./antigravity/index.js";
import {
  createNormalizedCacheStore,
  type NormalizedCacheStore,
} from "./cache/index.js";
import {
  createOpenCodeAdapter,
  isStatsRangeMismatch,
  type OpenCode2Adapter,
  type OpenCodeAdapterOptions,
} from "./opencode/index.js";

/** The default is intentionally explicit so a second CLI instance is safe. */
export function defaultCacheDirectory(): string {
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, "oc2token");
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "oc2token");
  return join(homedir(), ".cache", "oc2token");
}

function appendError(coverage: Coverage, error: CollectionError): Coverage {
  return {
    ...coverage,
    complete: false,
    errors: [...coverage.errors, error],
  };
}

function errorFor(error: unknown): CollectionError {
  if (error instanceof DomainError) {
    return {
      code: error.code === "cache-busy" ? "cache-busy" : "unknown",
      message: error.message,
      ...(error.sessionID === undefined ? {} : { sessionID: error.sessionID }),
      retryable: error.retryable,
    };
  }
  return {
    code: "unknown",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function addUsageTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  return toUsageTotals({
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
  });
}

function emptyUsageTotals(): UsageTotals {
  return toUsageTotals({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
}

function sortBreakdowns(values: Array<UsageBreakdown>): Array<UsageBreakdown> {
  values.sort(
    (left, right) => right.totals.recorded_total - left.totals.recorded_total || left.name.localeCompare(right.name),
  );
  return values;
}

/**
 * Single source of truth for provider/model/project splits: recompute from the
 * merged, deduplicated records in one window. Supplied per-source breakdowns
 * describe the same records, so merging both would double-count; callers use
 * this result when non-empty and fall back to merged supplied breakdowns only
 * when a window has no records (e.g. a stats source with zero records but
 * usable totals). Empty input yields empty outputs, preserving empty-source
 * behavior.
 */
function buildBreakdowns(
  records: ReadonlyArray<UsageRecord>,
  window: UsageWindow,
): { providers: Array<UsageBreakdown>; models: Array<UsageBreakdown>; projects: Array<UsageBreakdown> } {
  const windowRecords = records.filter((record) => containsInstant(window, record.createdAt));
  if (windowRecords.length === 0) return { providers: [], models: [], projects: [] };
  const byProvider = new Map<ProviderKind, UsageRecord[]>();
  const byModel = new Map<string, UsageRecord[]>();
  const byProject = new Map<string, UsageRecord[]>();
  for (const record of windowRecords) {
    const providerRecords = byProvider.get(record.provider);
    if (providerRecords === undefined) byProvider.set(record.provider, [record]);
    else providerRecords.push(record);
    const modelRecords = byModel.get(record.model);
    if (modelRecords === undefined) byModel.set(record.model, [record]);
    else modelRecords.push(record);
    if (record.project !== undefined && record.project.trim().length > 0) {
      const projectRecords = byProject.get(record.project);
      if (projectRecords === undefined) byProject.set(record.project, [record]);
      else projectRecords.push(record);
    }
  }
  const providers: Array<UsageBreakdown> = [];
  for (const [name, recs] of byProvider.entries()) {
    providers.push({ name, provider: name, totals: sumUsageRecords(recs, window) });
  }
  const models: Array<UsageBreakdown> = [];
  for (const [name, recs] of byModel.entries()) {
    models.push({ name, totals: sumUsageRecords(recs, window) });
  }
  const projects: Array<UsageBreakdown> = [];
  for (const [name, recs] of byProject.entries()) {
    projects.push({ name, totals: sumUsageRecords(recs, window) });
  }
  return {
    providers: sortBreakdowns(providers),
    models: sortBreakdowns(models),
    projects: sortBreakdowns(projects),
  };
}

function mergeBreakdowns(values: ReadonlyArray<UsageBreakdown>): ReadonlyArray<UsageBreakdown> {
  const merged = new Map<string, UsageBreakdown>();
  for (const value of values) {
    const key = `${value.name}\0${value.provider ?? ""}`;
    const current = merged.get(key);
    merged.set(
      key,
      current === undefined
        ? value
        : { ...current, totals: addUsageTotals(current.totals, value.totals) },
    );
  }
  return [...merged.values()].sort(
    (left, right) => right.totals.recorded_total - left.totals.recorded_total || left.name.localeCompare(right.name),
  );
}

function mergeTrends(
  successful: ReadonlyArray<{ readonly provider: ProviderKind; readonly result: CollectionResult }>,
  request: CollectionRequest,
): UsageTrendsByWindow | undefined {
  if (successful.length === 0) return undefined;

  const merged: Partial<Record<UsageWindowKind, readonly UsageTrendBucket[]>> = {};
  for (const window of request.windows) {
    const planned = createUsageTrendBuckets(window);
    const buckets: UsageTrendBucket[] = planned.map((bucket, index) => {
      let totals = emptyUsageTotals();
      for (const { result } of successful) {
        const supplied = result.trendsByWindow?.[window.kind]?.[index];
        const exact = supplied !== undefined &&
          supplied.from.getTime() === bucket.from.getTime() &&
          supplied.to.getTime() === bucket.to.getTime();
        const sourceTotals = exact
          ? supplied.totals
          : sumUsageRecords(result.records, {
              ...window,
              from: new Date(bucket.from.getTime()),
              to: new Date(bucket.to.getTime()),
              label: bucket.label,
            });
        totals = addUsageTotals(totals, sourceTotals);
      }
      return {
        label: bucket.label,
        from: new Date(bucket.from.getTime()),
        to: new Date(bucket.to.getTime()),
        totals,
      };
    });
    merged[window.kind] = buckets;
  }
  return merged as UsageTrendsByWindow;
}

/**
 * Selects exactly one accounting source for a refresh. Stats is used only if
 * every requested range is honored; a broader/ignored range switches the
 * whole refresh to the message scan and never combines the two totals.
 */
export class HybridUsageSource implements UsageSource {
  private statsUnsupportedFingerprint: string | undefined;

  constructor(
    readonly adapter: OpenCode2Adapter,
    readonly collectorOptions: CollectorOptions = {},
  ) {}

  private async connectIfNeeded(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DomainError("cancelled", "The refresh was cancelled");
    if (this.adapter.transport === undefined) {
      await this.adapter.connect(signal);
    }
  }

  private async fallback(request: CollectionRequest): Promise<CollectionResult> {
    const transport = this.adapter.transport;
    if (transport === undefined) {
      throw new DomainError("transport", "OpenCode 2 transport is not connected");
    }
    const result = await collectUsageParallel(transport, request, this.collectorOptions);
    const connection = this.adapter.currentConnection;
    return {
      ...result,
      ...(connection === undefined
        ? {}
        : {
            serverFingerprint: connection.health.fingerprint,
            serverVersion: connection.health.version,
          }),
    };
  }

  async collect(request: CollectionRequest): Promise<CollectionResult> {
    await this.connectIfNeeded(request.signal);
    const connection = this.adapter.currentConnection;
    const fingerprint = connection?.health.fingerprint;

    if (this.statsUnsupportedFingerprint !== undefined && this.statsUnsupportedFingerprint === fingerprint) {
      return this.fallback(request);
    }

    let reconnected = false;
    for (;;) {
      try {
        const result = await this.adapter.collect(request);
        const currentConnection = this.adapter.currentConnection;
        return {
          ...result,
          ...(currentConnection === undefined
            ? {}
            : {
                serverFingerprint: currentConnection.health.fingerprint,
                serverVersion: currentConnection.health.version,
              }),
        };
      } catch (error) {
        if (
          !reconnected &&
          this.adapter.options?.transport === undefined &&
          error instanceof DomainError &&
          error.code === "transport"
        ) {
          // A service restart invalidates the generated client connection. A
          // single reconnect keeps this refresh bounded; the coordinator's
          // next generation remains the retry path after a second failure.
          reconnected = true;
          await this.adapter.connect(request.signal);
          this.statsUnsupportedFingerprint = undefined;
          continue;
        }
        if (!isStatsRangeMismatch(error)) throw error;
        // Cache this decision for the live server fingerprint. A reconnect
        // above replaces the connection, so the stale entry-time fingerprint
        // must not be reused: re-read the current connection instead.
        this.statsUnsupportedFingerprint = this.adapter.currentConnection?.health.fingerprint ??
          fingerprint ?? "unknown";
        return this.fallback(request);
      }
    }
  }
}

export class CodexFileSource implements UsageSource {
  constructor(private readonly directory?: string) {}

  async collect(request: CollectionRequest): Promise<CollectionResult> {
    if (request.signal?.aborted) throw cancellationError();
    if (this.directory !== undefined) {
      const previous = process.env.CODEX_HOME;
      process.env.CODEX_HOME = this.directory;
      try {
        return await collectCodex(request);
      } finally {
        if (previous === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previous;
      }
    }
    return collectCodex(request);
  }
}

export class AntigravityFileSource implements UsageSource {
  constructor(private readonly directory?: string) {}

  async collect(request: CollectionRequest): Promise<CollectionResult> {
    if (request.signal?.aborted) throw cancellationError();
    if (this.directory !== undefined) {
      const previous = process.env.ANTIGRAVITY_HOME;
      process.env.ANTIGRAVITY_HOME = this.directory;
      try {
        return await collectAntigravity(request);
      } finally {
        if (previous === undefined) delete process.env.ANTIGRAVITY_HOME;
        else process.env.ANTIGRAVITY_HOME = previous;
      }
    }
    return collectAntigravity(request);
  }
}

export interface UnifiedUsageSourceOptions {
  readonly filterProviders?: Set<ProviderKind>;
}

export class UnifiedUsageSource implements UsageSource {
  private filterProviders: Set<ProviderKind> | undefined;

  constructor(
    readonly opencode: UsageSource,
    readonly codex: UsageSource,
    readonly antigravity: UsageSource,
    options: UnifiedUsageSourceOptions = {},
  ) {
    this.filterProviders = options.filterProviders === undefined || options.filterProviders.size === 0
      ? undefined
      : new Set(options.filterProviders);
  }

  getFilterProviders(): Set<ProviderKind> | undefined {
    return this.filterProviders === undefined ? undefined : new Set(this.filterProviders);
  }

  setFilterProviders(filter?: Set<ProviderKind>): void {
    if (filter === undefined || filter.size === 0) {
      this.filterProviders = undefined;
    } else {
      this.filterProviders = new Set(filter);
    }
  }

  async collect(request: CollectionRequest): Promise<CollectionResult> {
    if (request.signal?.aborted) {
      throw cancellationError(
        request.signal.reason instanceof Error ? request.signal.reason.message : undefined,
      );
    }
    if (request.windows.length === 0) {
      throw new DomainError("invalid-window", "Collection request must contain at least one usage window");
    }

    const filter = this.filterProviders;
    const shouldCollect = (provider: ProviderKind): boolean =>
      filter === undefined || filter.size === 0 || filter.has(provider);

    type Task = { provider: ProviderKind; source: UsageSource };
    const tasks: Task[] = [];
    if (shouldCollect("opencode")) tasks.push({ provider: "opencode", source: this.opencode });
    if (shouldCollect("codex")) tasks.push({ provider: "codex", source: this.codex });
    if (shouldCollect("antigravity")) tasks.push({ provider: "antigravity", source: this.antigravity });

    if (tasks.length === 0) {
      const emptyRecords: ReadonlyArray<UsageRecord> = [];
      const totalsByWindow: UsageTotalsByWindow = Object.fromEntries(
        request.windows.map((w) => [w.kind, sumUsageRecords(emptyRecords, w)]),
      );
      return {
        capturedAt: new Date(request.capturedAt.getTime()),
        windows: request.windows.map((w) => ({
          ...w,
          from: new Date(w.from.getTime()),
          to: new Date(w.to.getTime()),
        })),
        source: "unified",
        records: emptyRecords,
        totalsByWindow,
        coverage: {
          complete: true,
          sessionsDiscovered: 0,
          sessionsScanned: 0,
          sessionsSkipped: 0,
          pagesRead: 0,
          jobsRetried: 0,
          provisionalMessages: 0,
          errors: [],
        },
      };
    }

    const promises = tasks.map((task) => task.source.collect(request));
    const results = await Promise.allSettled(promises);

    for (const result of results) {
      if (result.status === "rejected" && isCancellationError(result.reason)) {
        throw result.reason instanceof DomainError
          ? result.reason
          : cancellationError(result.reason instanceof Error ? result.reason.message : undefined);
      }
    }
    if (request.signal?.aborted) {
      throw cancellationError(
        request.signal.reason instanceof Error ? request.signal.reason.message : undefined,
      );
    }

    const reducer = new UsageRecordReducer();
    let sessionsDiscovered = 0;
    let sessionsScanned = 0;
    let sessionsSkipped = 0;
    let pagesRead = 0;
    let jobsRetried = 0;
    let provisionalMessages = 0;
    let overallComplete = true;
    const prefixedErrors: CollectionError[] = [];
    const successful: Array<{ provider: ProviderKind; result: CollectionResult }> = [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]!;
      const settled = results[i]!;
      if (settled.status === "fulfilled") {
        const result = settled.value;
        successful.push({ provider: task.provider, result });
        const cov = result.coverage;
        sessionsDiscovered += cov.sessionsDiscovered;
        sessionsScanned += cov.sessionsScanned;
        sessionsSkipped += cov.sessionsSkipped;
        pagesRead += cov.pagesRead;
        jobsRetried += cov.jobsRetried;
        provisionalMessages += cov.provisionalMessages;
        if (!cov.complete) overallComplete = false;
        for (const err of cov.errors) {
          prefixedErrors.push({
            ...err,
            message: `[${task.provider}] ${err.message}`,
          });
        }
        reducer.upsertMany(result.records);
      } else {
        overallComplete = false;
        const raw = settled.reason;
        const base = toCollectionError(raw, "unknown");
        prefixedErrors.push({
          ...base,
          message: `[${task.provider}] ${base.message}`,
        });
      }
    }

    const sortedErrors = [...prefixedErrors].sort((a, b) =>
      (String(a.sessionID ?? "") + "\0" + a.code + "\0" + a.message).localeCompare(
        String(b.sessionID ?? "") + "\0" + b.code + "\0" + b.message,
      ),
    );

    const coverage: Coverage = {
      complete: overallComplete && sortedErrors.length === 0,
      sessionsDiscovered,
      sessionsScanned,
      sessionsSkipped,
      pagesRead,
      jobsRetried,
      provisionalMessages,
      errors: sortedErrors,
    };

    let records = reducer.records();
    records = [...records].sort((a, b) => {
      const providerCompare = a.provider.localeCompare(b.provider);
      if (providerCompare !== 0) return providerCompare;
      return a.key.localeCompare(b.key);
    });

    const totalsByWindow: UsageTotalsByWindow = Object.fromEntries(
      request.windows.map((w) => {
        const totals = successful.reduce((current, { result }) => {
          const sourceTotals = result.totalsByWindow[w.kind] ?? sumUsageRecords(result.records, w);
          return addUsageTotals(current, sourceTotals);
        }, emptyUsageTotals());
        return [w.kind, totals];
      }),
    );

    const providersMutable: Record<string, ReadonlyArray<UsageBreakdown>> = {};
    const modelsMutable: Record<string, ReadonlyArray<UsageBreakdown>> = {};
    const projectsMutable: Record<string, ReadonlyArray<UsageBreakdown>> = {};

    for (const w of request.windows) {
      // Single-source breakdowns: recomputed splits describe the same records
      // as the supplied per-source splits, so using both would double-count.
      // Prefer the recomputed split; fall back to merged supplied splits only
      // when the window has no records (e.g. stats totals without records).
      const recomputed = buildBreakdowns(records, w);
      const suppliedProviders = successful.flatMap(({ result }) => result.providersByWindow?.[w.kind] ?? []);
      if (recomputed.providers.length > 0) {
        providersMutable[w.kind] = recomputed.providers;
      } else if (suppliedProviders.length > 0) {
        providersMutable[w.kind] = mergeBreakdowns(suppliedProviders);
      }
      const suppliedModels = successful.flatMap(({ result }) => result.modelsByWindow?.[w.kind] ?? []);
      if (recomputed.models.length > 0) {
        modelsMutable[w.kind] = recomputed.models;
      } else if (suppliedModels.length > 0) {
        modelsMutable[w.kind] = mergeBreakdowns(suppliedModels);
      }
      const suppliedProjects = successful.flatMap(({ result }) => result.projectsByWindow?.[w.kind] ?? []);
      if (recomputed.projects.length > 0) {
        projectsMutable[w.kind] = recomputed.projects;
      } else if (suppliedProjects.length > 0) {
        projectsMutable[w.kind] = mergeBreakdowns(suppliedProjects);
      }
    }

    const providersByWindow: UsageBreakdownsByWindow = providersMutable;
    const modelsByWindow: UsageBreakdownsByWindow = modelsMutable;
    const projectsByWindow: UsageBreakdownsByWindow = projectsMutable;

    const presentProviders = new Set(records.map((r) => r.provider));
    let source: CollectionSource;
    if (presentProviders.size > 1) {
      source = "unified";
    } else if (presentProviders.size === 1) {
      const sole = [...presentProviders][0]!;
      if (sole === "codex") source = "codex";
      else if (sole === "antigravity") source = "antigravity";
      else {
        const opencodeResult = successful.find((s) => s.provider === "opencode");
        source = opencodeResult?.result.source ?? "message-scan";
      }
    } else {
      if (tasks.length > 1) {
        const distinctSources = new Set(successful.map((s) => s.result.source));
        if (distinctSources.size === 1) {
          const soleSource = [...distinctSources][0]!;
          source = tasks.length > 1 ? "unified" : soleSource;
        } else {
          source = "unified";
        }
      } else if (tasks.length === 1) {
        const soleTask = tasks[0]!;
        if (soleTask.provider === "codex") source = "codex";
        else if (soleTask.provider === "antigravity") source = "antigravity";
        else {
          const opencodeResult = successful.find((s) => s.provider === "opencode");
          source = opencodeResult?.result.source ?? "message-scan";
        }
      } else {
        source = "unified";
      }
    }

    const opencodeSuccess = successful.find((s) => s.provider === "opencode");
    const serverFingerprint = opencodeSuccess?.result.serverFingerprint;
    const serverVersion = opencodeSuccess?.result.serverVersion;
    const trendsByWindow = mergeTrends(successful, request);

    return {
      capturedAt: new Date(request.capturedAt.getTime()),
      windows: request.windows.map((w) => ({
        ...w,
        from: new Date(w.from.getTime()),
        to: new Date(w.to.getTime()),
      })),
      source,
      records,
      totalsByWindow,
      ...(Object.keys(providersMutable).length > 0
        ? { providersByWindow, providers: [...(providersMutable.week ?? providersMutable.day ?? providersMutable.hour ?? Object.values(providersMutable).flat())] }
        : {}),
      ...(Object.keys(modelsMutable).length > 0
        ? { modelsByWindow, models: [...(modelsMutable.week ?? modelsMutable.day ?? modelsMutable.hour ?? Object.values(modelsMutable).flat())] }
        : {}),
      ...(Object.keys(projectsMutable).length > 0
        ? { projectsByWindow, projects: [...(projectsMutable.week ?? projectsMutable.day ?? projectsMutable.hour ?? Object.values(projectsMutable).flat())] }
        : {}),
      ...(trendsByWindow === undefined ? {} : { trendsByWindow }),
      coverage,
      ...(serverFingerprint === undefined ? {} : { serverFingerprint }),
      ...(serverVersion === undefined ? {} : { serverVersion }),
    };
  }
}

/** Persist successful normalized metadata without making the cache a source of truth. */
export class CachedUsageSource implements UsageSource {
  constructor(
    readonly source: UsageSource,
    readonly store: NormalizedCacheStore,
  ) {}

  getFilterProviders(): Set<ProviderKind> | undefined {
    const inner = this.source as unknown as { getFilterProviders?: () => Set<ProviderKind> | undefined };
    return inner.getFilterProviders?.();
  }

  setFilterProviders(filter?: Set<ProviderKind>): void {
    const inner = this.source as unknown as { setFilterProviders?: (filter?: Set<ProviderKind>) => void };
    inner.setFilterProviders?.(filter);
  }

  get innerSource(): UsageSource {
    return this.source;
  }

  async collect(request: CollectionRequest): Promise<CollectionResult> {
    const result = await this.source.collect(request);
    const snapshot: StoredSnapshot = {
      schemaVersion: 1,
      generation: request.generation ?? 0,
      capturedAt: new Date(result.capturedAt.getTime()),
      requestedWindows: result.windows,
      source: result.source,
      records: result.records,
      totalsByWindow: result.totalsByWindow,
      ...(result.models === undefined ? {} : { models: result.models }),
      ...(result.providers === undefined ? {} : { providers: result.providers }),
      ...(result.projects === undefined ? {} : { projects: result.projects }),
      ...(result.modelsByWindow === undefined ? {} : { modelsByWindow: result.modelsByWindow }),
      ...(result.providersByWindow === undefined ? {} : { providersByWindow: result.providersByWindow }),
      ...(result.projectsByWindow === undefined ? {} : { projectsByWindow: result.projectsByWindow }),
      ...(result.trendsByWindow === undefined ? {} : { trendsByWindow: result.trendsByWindow }),
      coverage: result.coverage,
      ...(result.serverFingerprint === undefined ? {} : { serverFingerprint: result.serverFingerprint }),
      ...(result.serverVersion === undefined ? {} : { serverVersion: result.serverVersion }),
    };

    try {
      const committed = await this.store.commitDetailed(snapshot, result.records);
      if (committed.status === "cache_busy") {
        return { ...result, coverage: appendError(result.coverage, {
          code: "cache-busy",
          message: "Another oc2token process owns the cache; using in-memory data",
          retryable: true,
        }) };
      }
      if (committed.status === "cache_unavailable") {
        return { ...result, coverage: appendError(result.coverage, {
          code: "cache-unavailable",
          message: "The normalized cache could not be updated",
          retryable: true,
        }) };
      }
    } catch (error) {
      return { ...result, coverage: appendError(result.coverage, errorFor(error)) };
    }
    return result;
  }
}

export interface CachedSnapshotResult {
  readonly snapshot: CollectionResult | undefined;
  readonly store: NormalizedCacheStore;
}

export async function readCachedSnapshot(
  directory = defaultCacheDirectory(),
): Promise<CachedSnapshotResult> {
  const store = createNormalizedCacheStore({ directory });
  const cached = await store.readDetailed();
  if (cached.status !== "available") return { snapshot: undefined, store };
  const snapshot = cached.snapshot;
  return {
    store,
    snapshot: {
      capturedAt: new Date(snapshot.capturedAt.getTime()),
      windows: snapshot.requestedWindows,
      source: snapshot.source,
      records: snapshot.records,
      totalsByWindow: snapshot.totalsByWindow,
      ...(snapshot.models === undefined ? {} : { models: snapshot.models }),
      ...(snapshot.providers === undefined ? {} : { providers: snapshot.providers }),
      ...(snapshot.projects === undefined ? {} : { projects: snapshot.projects }),
      ...(snapshot.modelsByWindow === undefined ? {} : { modelsByWindow: snapshot.modelsByWindow }),
      ...(snapshot.providersByWindow === undefined ? {} : { providersByWindow: snapshot.providersByWindow }),
      ...(snapshot.projectsByWindow === undefined ? {} : { projectsByWindow: snapshot.projectsByWindow }),
      ...(snapshot.trendsByWindow === undefined ? {} : { trendsByWindow: snapshot.trendsByWindow }),
      coverage: snapshot.coverage,
      ...(snapshot.serverFingerprint === undefined ? {} : { serverFingerprint: snapshot.serverFingerprint }),
      ...(snapshot.serverVersion === undefined ? {} : { serverVersion: snapshot.serverVersion }),
    },
  };
}

export function newCollectionRequest(
  now: Date,
  timezone: string,
  options: Pick<CollectionRequest, "project" | "includeSubagents" | "includeProvisional" | "signal"> = {},
): CollectionRequest {
  const windows = Object.values(createUsageWindows(now, timezone));
  return {
    capturedAt: new Date(now.getTime()),
    windows,
    ...(options.project === undefined ? {} : { project: options.project }),
    includeSubagents: options.includeSubagents ?? true,
    includeProvisional: options.includeProvisional ?? false,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

export function emptyCollectionResult(now: Date, timezone: string): CollectionResult {
  const windows = Object.values(createUsageWindows(now, timezone));
  const coverage: Coverage = {
    complete: false,
    sessionsDiscovered: 0,
    sessionsScanned: 0,
    sessionsSkipped: 0,
    pagesRead: 0,
    jobsRetried: 0,
    provisionalMessages: 0,
    errors: [],
  };
  return {
    capturedAt: new Date(now.getTime()),
    windows,
    source: "message-scan",
    records: [],
    totalsByWindow: {},
    coverage,
  };
}

export interface ApplicationOptions extends OpenCodeAdapterOptions {
  readonly cacheDirectory?: string;
  readonly collectorOptions?: CollectorOptions;
  readonly codexDirectory?: string;
  readonly antigravityDirectory?: string;
  readonly filterProviders?: Set<ProviderKind>;
}

export function createApplicationSource(options: ApplicationOptions = {}): {
  readonly adapter: OpenCode2Adapter;
  readonly unified: UnifiedUsageSource;
  readonly source: CachedUsageSource;
  readonly store: NormalizedCacheStore;
} {
  const adapter = createOpenCodeAdapter(options);
  const hybrid = new HybridUsageSource(adapter, options.collectorOptions);
  const codexSource = new CodexFileSource(options.codexDirectory);
  const antigravitySource = new AntigravityFileSource(options.antigravityDirectory);
  const unifiedOptions =
    options.filterProviders === undefined ? undefined : { filterProviders: options.filterProviders };
  const unified = new UnifiedUsageSource(hybrid, codexSource, antigravitySource, unifiedOptions);
  const store = createNormalizedCacheStore({ directory: options.cacheDirectory ?? defaultCacheDirectory() });
  return { adapter, unified, source: new CachedUsageSource(unified, store), store };
}
