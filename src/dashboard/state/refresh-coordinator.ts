import { createUsageWindows, type UsageWindowKind } from "../../domain/windows.js";
import {
  RefreshScheduler,
  type RefreshSchedulerOptions,
  type TimerDriver,
} from "../scheduler/refresh-scheduler.js";
import type {
  Clock,
  DashboardNavigation,
  RefreshOutcome,
  RefreshReason,
  RefreshRequest,
  RefreshSchedulerLike,
  RefreshState,
  UsageSource,
} from "./types.js";
import type { CollectionResult } from "../../domain/index.js";

export interface RefreshCoordinatorOptions<Navigation = DashboardNavigation> {
  readonly source: UsageSource;
  readonly clock: Clock;
  readonly timezone: string;
  readonly project?: string;
  readonly refreshIntervalSeconds?: number;
  readonly timers?: TimerDriver;
  readonly scheduler?: RefreshSchedulerLike;
  readonly initialPeriod?: UsageWindowKind;
  readonly initialNavigation?: Navigation;
  /** Optional normalized cache snapshot shown while the first live refresh runs. */
  readonly initialSnapshot?: CollectionResult;
  readonly onStateChange?: (state: RefreshState<Navigation>) => void;
  /** Maximum time to wait for a source that ignores AbortSignal during quit. */
  readonly cleanupTimeoutMilliseconds?: number;
}

export type RefreshListener<Navigation> = (
  state: RefreshState<Navigation>,
) => void;

interface PendingRefresh {
  readonly resolve: (outcome: RefreshOutcome) => void;
}

interface ActiveRefresh {
  readonly generation: number;
  readonly reason: RefreshReason;
  readonly controller: AbortController;
  promise: Promise<RefreshOutcome>;
}

const REASON_PRIORITY: Record<Exclude<RefreshReason, "initial">, number> = {
  timer: 1,
  wake: 2,
  manual: 3,
};

function copyDate(date: Date): Date {
  return new Date(date.getTime());
}

function cancelledOutcome(generation: number, reason: RefreshReason): RefreshOutcome {
  return { kind: "cancelled", generation, reason };
}

/**
 * Owns every visible refresh transition. Sources do not mutate dashboard
 * state; they return one result which is committed only by its current
 * generation.
 */
export class RefreshCoordinator<
  Navigation = DashboardNavigation,
> {
  private readonly source: UsageSource;
  private readonly clock: Clock;
  private readonly timezone: string;
  private readonly project: string | undefined;
  private readonly listeners = new Set<RefreshListener<Navigation>>();
  private readonly scheduler: RefreshSchedulerLike;
  private readonly cleanupTimeoutMilliseconds: number;
  private state: RefreshState<Navigation>;
  private active: ActiveRefresh | undefined;
  private pendingReason: Exclude<RefreshReason, "initial"> | undefined;
  private pendingWaiters: PendingRefresh[] = [];
  private nextGeneration = 0;
  private started = false;
  private quitting = false;
  private startPromise: Promise<RefreshOutcome> | undefined;
  private readonly configuredOnStateChange: RefreshCoordinatorOptions<Navigation>["onStateChange"];

  constructor(options: RefreshCoordinatorOptions<Navigation>) {
    this.source = options.source;
    this.clock = options.clock;
    this.timezone = options.timezone;
    this.project = options.project;
    this.cleanupTimeoutMilliseconds = options.cleanupTimeoutMilliseconds ?? 250;
    if (!Number.isFinite(this.cleanupTimeoutMilliseconds) || this.cleanupTimeoutMilliseconds < 0) {
      throw new RangeError("cleanupTimeoutMilliseconds must be non-negative");
    }
    this.configuredOnStateChange = options.onStateChange;

    this.state = {
      status: "idle",
      generation: 0,
      stale: false,
      period: options.initialPeriod ?? "day",
      navigation: options.initialNavigation ?? ({} as Navigation),
      ...(options.initialSnapshot === undefined
        ? {}
        : {
            snapshot: options.initialSnapshot,
            lastGoodSnapshot: options.initialSnapshot,
            lastUpdated: new Date(options.initialSnapshot.capturedAt.getTime()),
            stale: true,
          }),
    };

    this.scheduler = options.scheduler ?? new RefreshScheduler({
      clock: options.clock,
      refreshIntervalSeconds: options.refreshIntervalSeconds,
      timers: options.timers,
      onRequest: (reason) => this.handleScheduledRequest(reason),
    } satisfies RefreshSchedulerOptions);
  }

  get refreshScheduler(): RefreshSchedulerLike {
    return this.scheduler;
  }

  get isRefreshing(): boolean {
    return this.active !== undefined;
  }

  get isStopped(): boolean {
    return this.quitting;
  }

  getState(): RefreshState<Navigation> {
    // Dates are copied so a renderer cannot mutate coordinator state between
    // event-loop turns. Result/navigation are owned by their immutable seams.
    return {
      ...this.state,
      ...(this.state.lastUpdated === undefined
        ? {}
        : { lastUpdated: copyDate(this.state.lastUpdated) }),
      ...(this.state.nextRefreshAt === undefined
        ? {}
        : { nextRefreshAt: this.state.nextRefreshAt }),
      ...(this.active === undefined ? {} : { activeGeneration: this.active.generation }),
      ...(this.scheduler.nextRefreshAt() === undefined
        ? { nextRefreshAt: undefined, countdownSeconds: undefined }
        : {
            nextRefreshAt: this.scheduler.nextRefreshAt(),
            countdownSeconds: this.scheduler.countdownSeconds(),
          }),
    };
  }

  subscribe(listener: RefreshListener<Navigation>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setPeriod(period: UsageWindowKind): void {
    this.state = { ...this.state, period };
    this.emit();
  }

  setNavigation(navigation: Navigation): void {
    this.state = { ...this.state, navigation };
    this.emit();
  }

  get refreshIntervalSeconds(): number {
    return (this.scheduler as unknown as { refreshIntervalSeconds?: number }).refreshIntervalSeconds
      ?? this.scheduler.refreshIntervalSeconds
      ?? 0;
  }

  setRefreshIntervalSeconds(seconds: number): void {
    if (this.scheduler.setRefreshIntervalSeconds === undefined) {
      throw new Error("Scheduler does not support dynamic interval updates");
    }
    this.scheduler.setRefreshIntervalSeconds(seconds);
    this.emit();
  }

  /** Start the scheduler and immediately issue exactly one initial refresh. */
  start(): Promise<RefreshOutcome> {
    if (this.started) {
      return this.startPromise ?? Promise.resolve(cancelledOutcome(this.nextGeneration, "initial"));
    }

    this.started = true;
    this.scheduler.start();
    this.startPromise = this.begin("initial");
    return this.startPromise;
  }

  /** Request a refresh; concurrent requests are reduced to one pending reason. */
  request(reason: Exclude<RefreshReason, "initial"> | "initial" = "manual"): Promise<RefreshOutcome> {
    if (!this.started || this.quitting) {
      return Promise.resolve(cancelledOutcome(this.nextGeneration, reason));
    }

    if (reason === "manual" || reason === "wake") {
      this.scheduler.reset();
    }

    if (this.active !== undefined) {
      if (reason === "initial") {
        return this.active.promise;
      }
      this.pendingReason = this.mergePendingReason(this.pendingReason, reason);
      this.state = { ...this.state, pendingReason: this.pendingReason };
      this.emit();

      return new Promise<RefreshOutcome>((resolve) => {
        this.pendingWaiters.push({ resolve });
      });
    }

    return this.begin(reason);
  }

  refresh(): Promise<RefreshOutcome> {
    return this.request("manual");
  }

  manualRefresh(): Promise<RefreshOutcome> {
    return this.request("manual");
  }

  wake(): Promise<RefreshOutcome> {
    return this.request("wake");
  }

  /**
   * Stop scheduling, invalidate the current generation, abort network work,
   * and wait only briefly for sources which honor cancellation.
   *
   * cleanupTimeoutMilliseconds (default 250ms) bounds quit latency: sources
   * honoring AbortSignal settle promptly, while sync scans that ignore the
   * signal keep running orphaned in the background. Their late results are
   * discarded via the generation guard, but their CPU/IO is not reclaimed —
   * this is intentional to keep quit responsive; use a larger timeout if
   * clean scan shutdown matters more than fast exit.
   */
  async quit(): Promise<void> {
    if (this.quitting) {
      return;
    }

    this.quitting = true;
    this.scheduler.stop();
    this.nextGeneration += 1;

    const active = this.active;
    if (active !== undefined) {
      active.controller.abort();
    }

    const cancelled = cancelledOutcome(this.nextGeneration, "manual");
    for (const waiter of this.pendingWaiters) {
      waiter.resolve(cancelled);
    }
    this.pendingWaiters = [];
    this.pendingReason = undefined;

    this.state = {
      ...this.state,
      status: "stopped",
      generation: this.nextGeneration,
      activeGeneration: undefined,
      pendingReason: undefined,
    };
    this.emit();

    if (active !== undefined) {
      await this.waitForCleanup(active.promise);
    }
  }

  private begin(reason: RefreshReason): Promise<RefreshOutcome> {
    if (this.quitting) {
      return Promise.resolve(cancelledOutcome(this.nextGeneration, reason));
    }

    const generation = ++this.nextGeneration;
    const controller = new AbortController();
    const wallNow = copyDate(this.clock.wallNow());
    const monotonicStartedAt = this.clock.monotonicNow();

    const active: ActiveRefresh = {
      generation,
      reason,
      controller,
      promise: Promise.resolve(cancelledOutcome(generation, reason)),
    };
    this.active = active;
    this.state = {
      ...this.state,
      status: "refreshing",
      generation,
      activeGeneration: generation,
      pendingReason: undefined,
      // A previous result remains visible while the next one is loading.
      stale: this.state.lastGoodSnapshot !== undefined,
    };
    this.emit();

    active.promise = Promise.resolve()
      .then(() => {
        const request: RefreshRequest = {
          generation,
          reason,
          wallNow,
          monotonicStartedAt,
          capturedAt: wallNow,
          windows: Object.values(createUsageWindows(wallNow, this.timezone)),
          ...(this.project === undefined ? {} : { project: this.project }),
          includeSubagents: true,
          includeProvisional: false,
          signal: controller.signal,
        };
        return this.source.collect(request);
      })
      .then(
        (result): RefreshOutcome => {
          if (
            this.quitting ||
            controller.signal.aborted ||
            this.active !== active ||
            this.nextGeneration !== generation
          ) {
            return { kind: "discarded", generation, reason };
          }

          const lastUpdated = copyDate(this.clock.wallNow());
          this.state = {
            ...this.state,
            status: "ready",
            generation,
            activeGeneration: undefined,
            snapshot: result,
            lastGoodSnapshot: result,
            lastUpdated,
            lastError: undefined,
            stale: false,
          };
          this.emit();
          return { kind: "committed", generation, reason, result };
        },
        (error): RefreshOutcome => {
          if (
            this.quitting ||
            controller.signal.aborted ||
            this.active !== active ||
            this.nextGeneration !== generation
          ) {
            return { kind: "cancelled", generation, reason, error };
          }

          this.state = {
            ...this.state,
            status: "error",
            generation,
            activeGeneration: undefined,
            // Keep the last good snapshot in both fields. A renderer can show
            // the error without losing the most recent trustworthy totals.
            snapshot: this.state.lastGoodSnapshot,
            lastError: error,
            stale: this.state.lastGoodSnapshot !== undefined,
          };
          this.emit();
          return { kind: "failed", generation, reason, error };
        },
      )
      .finally(() => {
        if (this.active !== active) {
          return;
        }

        this.active = undefined;
        this.state = {
          ...this.state,
          activeGeneration: undefined,
        };
        this.emit();

        // A slow initial must not cause an immediate second refresh: the
        // scheduler was armed at start(), so restart the cadence from
        // completion. Timer-only pending fired during the initial is already
        // satisfied by the fresh result and is dropped below.
        if (reason === "initial" && !this.quitting) {
          try {
            this.scheduler.reset();
          } catch {
            // Reset is best-effort; a failed reset leaves the old deadline.
          }
        }

        if (!this.quitting && this.pendingReason !== undefined) {
          if (reason === "initial" && this.pendingReason === "timer") {
            const waiters = this.pendingWaiters;
            this.pendingReason = undefined;
            this.pendingWaiters = [];
            this.state = { ...this.state, pendingReason: undefined };
            this.emit();
            for (const waiter of waiters) {
              waiter.resolve({ kind: "discarded", generation, reason: "timer" });
            }
            return;
          }
          const pendingReason = this.pendingReason;
          const waiters = this.pendingWaiters;
          this.pendingReason = undefined;
          this.pendingWaiters = [];
          this.state = { ...this.state, pendingReason: undefined };
          this.emit();
          void this.begin(pendingReason).then((outcome) => {
            for (const waiter of waiters) {
              waiter.resolve(outcome);
            }
          });
        }
      });

    return active.promise;
  }

  private mergePendingReason(
    current: Exclude<RefreshReason, "initial"> | undefined,
    requested: Exclude<RefreshReason, "initial">,
  ): Exclude<RefreshReason, "initial"> {
    if (current === undefined || REASON_PRIORITY[requested] > REASON_PRIORITY[current]) {
      return requested;
    }
    return current;
  }

  private handleScheduledRequest(reason: Exclude<RefreshReason, "initial">): void {
    if (!this.started || this.quitting) {
      return;
    }

    // Timer callbacks have no caller waiting for a Promise. Update the one
    // pending reason in place so delayed wake/sleep periods cannot accumulate
    // an unbounded waiter queue.
    if (this.active !== undefined) {
      this.pendingReason = this.mergePendingReason(this.pendingReason, reason);
      this.state = { ...this.state, pendingReason: this.pendingReason };
      this.emit();
      return;
    }

    void this.request(reason);
  }

  private async waitForCleanup(activePromise: Promise<RefreshOutcome>): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, this.cleanupTimeoutMilliseconds);
      if (timeoutHandle !== undefined && typeof timeoutHandle === "object" && "unref" in timeoutHandle) {
        (timeoutHandle as unknown as { unref(): void }).unref();
      }
    });

    await Promise.race([activePromise.then(() => undefined), timeout]);
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }

  private emit(): void {
    const next = this.getState();
    this.configuredOnStateChange?.(next);
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}

export { RefreshScheduler };
