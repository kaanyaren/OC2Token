import type {
  Clock as DomainClock,
  CollectionRequest,
  CollectionResult,
  UsageSource as DomainUsageSource,
  UsageWindow,
  UsageWindowKind,
} from "../../domain/index.js";

/** Reasons which can enter the refresh lifecycle. */
export type RefreshReason = "initial" | "timer" | "manual" | "wake";

/**
 * The clock used by the dashboard. `wallNow` is for report windows and
 * timestamps; `monotonicNow` is for scheduling and countdowns.
 */
export type Clock = DomainClock;

/** The request handed to the usage source for one immutable generation. */
export interface RefreshRequest extends CollectionRequest {
  readonly generation: number;
  readonly reason: RefreshReason;
  readonly wallNow: Date;
  readonly monotonicStartedAt: number;
  readonly capturedAt: Date;
  readonly windows: ReadonlyArray<UsageWindow>;
  readonly signal: AbortSignal;
}

/**
 * This is deliberately structural. The collector/domain seam can return its
 * immutable CollectionResult directly, so the dashboard never knows how the
 * result is assembled or persisted.
 */
export type UsageSource = DomainUsageSource;

export type DashboardStatus =
  | "idle"
  | "refreshing"
  | "ready"
  | "error"
  | "stopped";

export interface DashboardNavigation {
  readonly panel?: string;
  readonly index?: number;
  readonly scrollOffset?: number;
  readonly [key: string]: unknown;
}

export interface RefreshState<Navigation = DashboardNavigation> {
  readonly status: DashboardStatus;
  readonly generation: number;
  readonly activeGeneration?: number;
  /** The latest successful result, retained while a refresh is in flight/fails. */
  readonly snapshot?: CollectionResult;
  readonly lastGoodSnapshot?: CollectionResult;
  readonly lastUpdated?: Date;
  readonly lastError?: unknown;
  readonly stale: boolean;
  readonly pendingReason?: Exclude<RefreshReason, "initial">;
  readonly period: UsageWindowKind;
  readonly navigation: Navigation;
  /** Monotonic deadline; absent in manual-only mode. */
  readonly nextRefreshAt?: number;
  /** Whole seconds remaining, derived from monotonic time. */
  readonly countdownSeconds?: number;
}

export type RefreshOutcomeKind = "committed" | "failed" | "discarded" | "cancelled";

export interface RefreshOutcome {
  readonly kind: RefreshOutcomeKind;
  readonly generation: number;
  readonly reason: RefreshReason;
  readonly result?: CollectionResult;
  readonly error?: unknown;
}

export interface RefreshSchedulerLike {
  start(): void;
  stop(): void;
  reset(): void;
  manual(): void;
  wake(): void;
  countdownSeconds(): number | undefined;
  nextRefreshAt(): number | undefined;
}
