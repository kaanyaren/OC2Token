import {
  DomainError,
  isCancellationError,
  type CollectionRequest,
  type CollectionResult,
  type Coverage,
  type OpenCodeProject,
  type OpenCodeSessionStats,
  type OpenCodeTransport,
  type UsageBreakdown,
  type UsageSource,
  type UsageTotals,
  type UsageWindowKind,
  type UsageBreakdownsByWindow,
  createUsageTrendBuckets,
  type UsageTrendBucket,
  type UsageTrendsByWindow,
} from "../domain/index.js";
import type { StatsRequestOptions } from "./transport.js";
import { isStatsRangeMismatch } from "./transport.js";
import { costForTokens, pricingForModel } from "../pricing/pricing.js";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DomainError("cancelled", "The operation was cancelled");
}

const completeStatsCoverage: Coverage = {
  complete: true,
  sessionsDiscovered: 0,
  sessionsScanned: 0,
  sessionsSkipped: 0,
  pagesRead: 0,
  jobsRetried: 0,
  provisionalMessages: 0,
  errors: [],
};

const TREND_WORKERS = 4;
const PROJECT_WORKERS = 4;

function estimatedBreakdownCost(
  breakdowns: ReadonlyArray<UsageBreakdown> | undefined,
): number | undefined {
  if (breakdowns === undefined) return undefined;
  let total = 0;
  let priced = 0;
  for (const breakdown of breakdowns) {
    const cost = breakdown.cost ?? (() => {
      const pricing = pricingForModel(breakdown.name);
      return pricing === undefined ? undefined : costForTokens(breakdown.totals, pricing);
    })();
    if (cost === undefined) continue;
    total += cost;
    priced += 1;
  }
  return priced === 0 ? undefined : Math.round(total * 1_000_000) / 1_000_000;
}

function withStatsBreakdownCosts(
  result: OpenCodeSessionStats,
): { models?: ReadonlyArray<UsageBreakdown>; providers?: ReadonlyArray<UsageBreakdown> } {
  const models = result.models?.map((model) => {
    if (model.cost !== undefined) return model;
    const cost = estimatedBreakdownCost([model]);
    return cost === undefined ? model : { ...model, cost };
  });
  const providerCosts = new Map<string, number>();
  for (const model of models ?? []) {
    if (model.provider === undefined || model.cost === undefined) continue;
    providerCosts.set(model.provider, (providerCosts.get(model.provider) ?? 0) + model.cost);
  }
  const providers = result.providers?.map((provider) => {
    if (provider.cost !== undefined) return provider;
    const cost = providerCosts.get(provider.name);
    return cost === undefined ? provider : { ...provider, cost: Math.round(cost * 1_000_000) / 1_000_000 };
  });
  return { models, providers };
}

async function collectProjectBreakdowns(
  transport: OpenCodeTransport,
  window: CollectionRequest["windows"][number],
  projects: ReadonlyArray<OpenCodeProject>,
  signal?: AbortSignal,
): Promise<ReadonlyArray<UsageBreakdown>> {
  if (projects.length === 0) return [];
  const results: Array<UsageBreakdown | undefined> = new Array(projects.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      throwIfAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      if (index >= projects.length) return;
      const project = projects[index]!;
      try {
        const result = await transport.getSessionStats(window, { project: project.id, signal });
        if (result.totals.recorded_total > 0) {
          const cost = estimatedBreakdownCost(result.models);
          results[index] = {
            name: project.canonical,
            totals: result.totals,
            ...(cost === undefined ? {} : { cost }),
          };
        }
      } catch (error) {
        if (isCancellationError(error) || (error instanceof DomainError && error.code === "cancelled")) {
          throw error;
        }
        // Per-project failures are non-fatal; a single project's stats
        // must not abort the whole refresh (range mismatch, 404, etc.)
        results[index] = undefined;
      }
    }
  }

  const workers = Math.min(PROJECT_WORKERS, projects.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  throwIfAborted(signal);
  return results
    .filter((value): value is UsageBreakdown => value !== undefined)
    .sort((a, b) => b.totals.recorded_total - a.totals.recorded_total || a.name.localeCompare(b.name));
}

async function collectTrendBuckets(
  transport: OpenCodeTransport,
  window: CollectionRequest["windows"][number],
  options: StatsRequestOptions,
): Promise<readonly UsageTrendBucket[]> {
  const buckets = createUsageTrendBuckets(window);
  const results: Array<UsageTrendBucket | undefined> = new Array(buckets.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      throwIfAborted(options.signal);
      const index = nextIndex;
      nextIndex += 1;
      if (index >= buckets.length) return;
      const bucket = buckets[index]!;
      // Retain the parent window metadata for fakes and diagnostics while
      // sending the bucket's exact range to the transport.
      const query = {
        ...window,
        from: new Date(bucket.from.getTime()),
        to: new Date(bucket.to.getTime()),
        label: bucket.label,
      };
      try {
        const result = await transport.getSessionStats(query, options);
        results[index] = {
          label: bucket.label,
          from: new Date(bucket.from.getTime()),
          to: new Date(bucket.to.getTime()),
          totals: result.totals,
        };
      } catch (error) {
        if (isCancellationError(error) || (error instanceof DomainError && error.code === "cancelled")) {
          throw error;
        }
        // A range mismatch means the server cannot honor bounded stats at all;
        // propagate so HybridUsageSource falls back to the message scan for the
        // whole refresh instead of returning silently gapped trends.
        if (isStatsRangeMismatch(error)) throw error;
        // Any other per-bucket failure (404, per-range 5xx after transport
        // retries, malformed bucket payload) is isolated: the bucket is omitted
        // and remaining buckets still resolve. Callers must treat a short
        // bucket list as partial rather than complete.
        results[index] = undefined;
      }
    }
  }

  const workerCount = Math.min(TREND_WORKERS, buckets.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  throwIfAborted(options.signal);
  return results.filter((value): value is UsageTrendBucket => value !== undefined);
}

/** UsageSource implementation for a range-validated /api/session/stats path. */
export class OpenCodeStatsSource implements UsageSource {
  readonly transport: OpenCodeTransport;

  constructor(transport: OpenCodeTransport) {
    this.transport = transport;
  }

  async collect(request: CollectionRequest): Promise<CollectionResult> {
    throwIfAborted(request.signal);
    const health = await this.transport.getHealth({ signal: request.signal });
    const totalsByWindow: Partial<Record<UsageWindowKind, UsageTotals>> = {};
    const modelsByWindow: Partial<Record<UsageWindowKind, NonNullable<CollectionResult["models"]>>> = {};
    const providersByWindow: Partial<Record<UsageWindowKind, NonNullable<CollectionResult["providers"]>>> = {};
    const projectsByWindow: Partial<Record<UsageWindowKind, NonNullable<CollectionResult["projects"]>>> = {};
    const trendsByWindow: Partial<Record<UsageWindowKind, readonly UsageTrendBucket[]>> = {};
    let models = undefined;
    let providers = undefined;
    let projects = undefined;

    // Fetch project list once when not filtering to a single project.
    // Failures are non-fatal: the stats total remains usable without per-project split.
    //
    // Project filter heuristic: drop the synthetic global entries (`canonical
    // === "/"` or `id === "global"`) which aggregate every project and would
    // double-count if kept alongside per-project stats (they also typically
    // return zero for a scoped query). All remaining projects are queried and
    // only those with recorded_total > 0 are kept (see
    // collectProjectBreakdowns); per-project failures are isolated and skipped
    // rather than aborting the refresh.
    let allProjects: ReadonlyArray<OpenCodeProject> = [];
    if (request.project === undefined && typeof (this.transport as unknown as { listProjects?: unknown }).listProjects === "function") {
      try {
        const fetched = await (this.transport as unknown as { listProjects: (opts: unknown) => Promise<ReadonlyArray<OpenCodeProject>> }).listProjects({ signal: request.signal });
        allProjects = (fetched as ReadonlyArray<OpenCodeProject>).filter((p) => p.canonical !== "/" && p.id !== "global");
      } catch (error) {
        if (isCancellationError(error) || (error instanceof DomainError && error.code === "cancelled")) throw error;
        allProjects = [];
      }
    }

    // Keep each response associated with its immutable requested window. A
    // stats total is never combined with a message-scan total by this source.
    for (const window of request.windows) {
      throwIfAborted(request.signal);
      const options: StatsRequestOptions = {
        project: request.project,
        signal: request.signal,
      };
      const result = await this.transport.getSessionStats(window, options);
      const enriched = withStatsBreakdownCosts(result);
      totalsByWindow[window.kind] = result.totals;
      // Keep the widest requested window's breakdown for backwards-compatible
      // global fields, while also retaining each response for the selected
      // dashboard period.
      if (enriched.models !== undefined) {
        models = enriched.models;
        modelsByWindow[window.kind] = enriched.models;
      }
      if (enriched.providers !== undefined) {
        providers = enriched.providers;
        providersByWindow[window.kind] = enriched.providers;
      }
      trendsByWindow[window.kind] = await collectTrendBuckets(this.transport, window, options);

      if (allProjects.length > 0) {
        const breakdowns = await collectProjectBreakdowns(this.transport, window, allProjects, request.signal);
        if (breakdowns.length > 0) {
          projects = breakdowns;
          projectsByWindow[window.kind] = breakdowns;
        }
      }
    }

    throwIfAborted(request.signal);
    return {
      capturedAt: new Date(request.capturedAt.getTime()),
      windows: request.windows,
      source: "stats",
      records: [],
      totalsByWindow,
      ...(models === undefined ? {} : { models }),
      ...(providers === undefined ? {} : { providers }),
      ...(projects === undefined ? {} : { projects }),
      ...(Object.keys(modelsByWindow).length === 0 ? {} : { modelsByWindow: modelsByWindow as UsageBreakdownsByWindow }),
      ...(Object.keys(providersByWindow).length === 0 ? {} : { providersByWindow: providersByWindow as UsageBreakdownsByWindow }),
      ...(Object.keys(projectsByWindow).length === 0 ? {} : { projectsByWindow: projectsByWindow as UsageBreakdownsByWindow }),
      ...(Object.keys(trendsByWindow).length === 0 ? {} : { trendsByWindow: trendsByWindow as UsageTrendsByWindow }),
      coverage: completeStatsCoverage,
      serverFingerprint: health.fingerprint,
      serverVersion: health.version,
    };
  }
}

export function createOpenCodeStatsSource(transport: OpenCodeTransport): OpenCodeStatsSource {
  return new OpenCodeStatsSource(transport);
}
