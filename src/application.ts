import { homedir } from "node:os";
import { join } from "node:path";

import {
  DomainError,
  createUsageWindows,
  type CollectionRequest,
  type CollectionResult,
  type CollectionError,
  type Coverage,
  type StoredSnapshot,
  type UsageSource,
} from "./domain/index.js";
import { collectUsageParallel, type CollectorOptions } from "./collector/index.js";
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
  const root = process.env.XDG_CACHE_HOME ?? join(homedir(), "Library", "Caches");
  return join(root, "oc2token");
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
        // Cache this decision for the current server fingerprint. A version or
        // PID change causes the next refresh to probe the new implementation.
        this.statsUnsupportedFingerprint = fingerprint ?? "unknown";
        return this.fallback(request);
      }
    }
  }
}

/** Persist successful normalized metadata without making the cache a source of truth. */
export class CachedUsageSource implements UsageSource {
  constructor(
    readonly source: UsageSource,
    readonly store: NormalizedCacheStore,
  ) {}

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
}

export function createApplicationSource(options: ApplicationOptions = {}): {
  readonly adapter: OpenCode2Adapter;
  readonly source: CachedUsageSource;
  readonly store: NormalizedCacheStore;
} {
  const adapter = createOpenCodeAdapter(options);
  const hybrid = new HybridUsageSource(adapter, options.collectorOptions);
  const store = createNormalizedCacheStore({ directory: options.cacheDirectory ?? defaultCacheDirectory() });
  return { adapter, source: new CachedUsageSource(hybrid, store), store };
}
