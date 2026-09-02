import {
  DomainError,
  type CollectionRequest,
  type CollectionResult,
  type Coverage,
  type OpenCodeTransport,
  type UsageSource,
  type UsageTotals,
  type UsageWindowKind,
  type UsageBreakdownsByWindow,
} from "../domain/index.js";
import type { StatsRequestOptions } from "./transport.js";

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
    let models = undefined;
    let providers = undefined;

    // Keep each response associated with its immutable requested window. A
    // stats total is never combined with a message-scan total by this source.
    for (const window of request.windows) {
      throwIfAborted(request.signal);
      const options: StatsRequestOptions = {
        project: request.project,
        signal: request.signal,
      };
      const result = await this.transport.getSessionStats(window, options);
      totalsByWindow[window.kind] = result.totals;
      // Keep the widest requested window's breakdown for backwards-compatible
      // global fields, while also retaining each response for the selected
      // dashboard period.
      if (result.models !== undefined) {
        models = result.models;
        modelsByWindow[window.kind] = result.models;
      }
      if (result.providers !== undefined) {
        providers = result.providers;
        providersByWindow[window.kind] = result.providers;
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
      ...(Object.keys(modelsByWindow).length === 0 ? {} : { modelsByWindow: modelsByWindow as UsageBreakdownsByWindow }),
      ...(Object.keys(providersByWindow).length === 0 ? {} : { providersByWindow: providersByWindow as UsageBreakdownsByWindow }),
      coverage: completeStatsCoverage,
      serverFingerprint: health.fingerprint,
      serverVersion: health.version,
    };
  }
}

export function createOpenCodeStatsSource(transport: OpenCodeTransport): OpenCodeStatsSource {
  return new OpenCodeStatsSource(transport);
}
