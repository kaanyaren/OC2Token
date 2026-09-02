import type { CollectionError } from "./errors.js";
import type { TokenComponentsInput, UsageTotals } from "./tokens.js";
import type { UsageRecord, UsageRecordCompleteness } from "./records.js";
import type { UsageWindow, UsageWindowKind } from "./windows.js";

export type CollectionSource = "stats" | "message-scan";

/**
 * Coverage describes what a collection actually observed. `complete` means
 * traversal finished without a known gap; it does not turn provisional usage
 * into final usage and it must never be inferred from non-zero totals.
 */
export interface Coverage {
  readonly complete: boolean;
  readonly sessionsDiscovered: number;
  readonly sessionsScanned: number;
  readonly sessionsSkipped: number;
  readonly pagesRead: number;
  readonly jobsRetried: number;
  readonly provisionalMessages: number;
  readonly errors: ReadonlyArray<CollectionError>;
}

export type UsageTotalsByWindow = Readonly<
  Partial<Record<UsageWindowKind, UsageTotals>>
>;

/** Aggregate model/provider data returned by the stats endpoint. */
export interface UsageBreakdown {
  readonly name: string;
  readonly provider?: string;
  readonly totals: UsageTotals;
}

/**
 * One immutable collection intent. `capturedAt` and `windows` are created
 * together so hour/day/week workers cannot each choose a different `now`.
 *
 * Recoverable item failures should be represented in a resolved partial result
 * with `coverage.complete === false`. Cancellation is control flow instead:
 * implementations must reject with a `DomainError` whose code is `cancelled`
 * after observing `signal`; callers may retain a prior snapshot but may not
 * publish the cancelled result as current.
 */
export interface CollectionRequest {
  readonly capturedAt: Date;
  readonly windows: ReadonlyArray<UsageWindow>;
  readonly project?: string;
  /** Defaults to true in the collector; child sessions are model work. */
  readonly includeSubagents?: boolean;
  /** Defaults to false so provisional usage is not silently presented as final. */
  readonly includeProvisional?: boolean;
  /** Refresh generation used to discard late results. */
  readonly generation?: number;
  readonly signal?: AbortSignal;
}

/**
 * A collection may be partial while still carrying useful records. Consumers
 * must inspect Coverage and source together with totals. No implementation may
 * combine stats totals and message-scan totals for the same requested window.
 */
export interface CollectionResult {
  readonly capturedAt: Date;
  readonly windows: ReadonlyArray<UsageWindow>;
  readonly source: CollectionSource;
  readonly records: ReadonlyArray<UsageRecord>;
  readonly totalsByWindow: UsageTotalsByWindow;
  readonly models?: ReadonlyArray<UsageBreakdown>;
  readonly providers?: ReadonlyArray<UsageBreakdown>;
  readonly coverage: Coverage;
  readonly serverFingerprint?: string;
  readonly serverVersion?: string;
}

export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

/**
 * Persistable read model. A store commit must publish this as one immutable
 * snapshot (normally via temp-file flush and same-directory rename). A failed
 * commit leaves the previous snapshot readable. Store cancellation before the
 * atomic publish must reject and must not report a successful commit.
 */
export interface StoredSnapshot {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  readonly generation: number;
  readonly capturedAt: Date;
  readonly requestedWindows: ReadonlyArray<UsageWindow>;
  readonly source: CollectionSource;
  readonly records: ReadonlyArray<UsageRecord>;
  readonly totalsByWindow: UsageTotalsByWindow;
  readonly models?: ReadonlyArray<UsageBreakdown>;
  readonly providers?: ReadonlyArray<UsageBreakdown>;
  readonly coverage: Coverage;
  readonly serverFingerprint?: string;
  readonly serverVersion?: string;
}

export interface TransportRequestOptions {
  /** A transport must stop issuing work and reject with cancellation promptly. */
  readonly signal?: AbortSignal;
}

export interface SessionListRequest extends TransportRequestOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface MessageListRequest extends TransportRequestOptions {
  readonly sessionID: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface OpenCodeSession {
  readonly sessionID: string;
  readonly parentSessionID?: string;
}

export interface OpenCodeAssistantMessage {
  readonly sessionID: string;
  readonly messageID: string;
  readonly createdAt: Date;
  readonly model: string;
  /** Undefined means the API omitted the token object, not zero usage. */
  readonly tokens?: TokenComponentsInput;
  readonly completeness: UsageRecordCompleteness;
}

export interface SessionPage {
  readonly sessions: ReadonlyArray<OpenCodeSession>;
  /** `null` means exhausted; a repeated cursor is a protocol error. */
  readonly nextCursor: string | null;
}

export interface MessagePage {
  readonly messages: ReadonlyArray<OpenCodeAssistantMessage>;
  /** `null` means exhausted; a repeated cursor is a protocol error. */
  readonly nextCursor: string | null;
}

export interface OpenCodeHealth {
  readonly version: string;
  readonly fingerprint: string;
}

export interface OpenCodeRange {
  readonly from: Date;
  readonly to: Date;
  readonly timezone: string;
}

export interface OpenCodeSessionStats {
  readonly requestedWindow: UsageWindow;
  /** The server-reported range must be compared with requestedWindow by the collector. */
  readonly reportedRange: OpenCodeRange;
  readonly totals: UsageTotals;
  readonly models?: ReadonlyArray<UsageBreakdown>;
  readonly providers?: ReadonlyArray<UsageBreakdown>;
}

/**
 * Adapter seam for the read-only OpenCode 2 V2 server API.
 *
 * Every operation is an idempotent read. Implementations may retry reads but
 * must not duplicate accounting as a retry side effect. They must honor an
 * AbortSignal promptly, reject with cancellation rather than return a falsely
 * complete page, and avoid exposing prompts/tool content in these DTOs.
 * `getSessionStats` is usable only after its reported range is validated;
 * callers must fall back to paginated messages when the server ignores bounds.
 */
export interface OpenCodeTransport {
  getHealth(options?: TransportRequestOptions): Promise<OpenCodeHealth>;
  getSessionStats(
    window: UsageWindow,
    options?: TransportRequestOptions,
  ): Promise<OpenCodeSessionStats>;
  listSessions(request?: SessionListRequest): Promise<SessionPage>;
  listMessages(request: MessageListRequest): Promise<MessagePage>;
}

/** A source such as stats or a paginated message collector. */
export interface UsageSource {
  /**
   * Resolve with a partial result for bounded, recoverable scan gaps. Reject
   * cancellation so the refresh coordinator can discard this generation;
   * never label a partial or cancelled result as complete.
   */
  collect(request: CollectionRequest): Promise<CollectionResult>;
}

export interface SnapshotStoreReadOptions extends TransportRequestOptions {}
export interface SnapshotStoreCommitOptions extends TransportRequestOptions {}

/**
 * Process-safe snapshot persistence seam. Implementations serialize commits;
 * a cache-busy condition should be reported rather than waiting forever, so a
 * caller can continue with in-memory data and visible stale/partial status.
 */
export interface SnapshotStore {
  read(options?: SnapshotStoreReadOptions): Promise<StoredSnapshot | null>;
  commit(
    snapshot: StoredSnapshot,
    options?: SnapshotStoreCommitOptions,
  ): Promise<void>;
}

/**
 * Wall time drives calendar windows; monotonic milliseconds drive scheduling
 * and elapsed-time budgets. Tests provide a fake implementation for both.
 */
export interface Clock {
  wallNow(): Date;
  monotonicNow(): number;
}
