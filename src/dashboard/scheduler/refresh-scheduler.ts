import type { Clock, RefreshReason } from "../state/types.js";

export const DEFAULT_REFRESH_INTERVAL_SECONDS = 300;
export const DEFAULT_REFRESH_INTERVAL_MS = DEFAULT_REFRESH_INTERVAL_SECONDS * 1000;

export interface TimerDriver {
  setTimeout(callback: () => void, delayMilliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemTimers: TimerDriver = {
  setTimeout(callback, delayMilliseconds) {
    const handle = setTimeout(callback, delayMilliseconds);
    // Do not keep a non-interactive process alive solely for a dashboard timer.
    if (typeof handle === "object" && handle !== null && "unref" in handle) {
      (handle as { unref(): void }).unref();
    }
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface RefreshSchedulerOptions {
  readonly clock: Clock;
  readonly onRequest: (reason: Exclude<RefreshReason, "initial">) => void;
  readonly refreshIntervalSeconds?: number;
  readonly timers?: TimerDriver;
}

/**
 * Monotonic, one-shot refresh scheduler.
 *
 * There is only ever one armed timer. Resetting it invalidates the old timer
 * callback as well as clearing it, which protects fake timer implementations
 * and hosts that deliver a callback after clearTimeout.
 */
export class RefreshScheduler {
  private readonly clock: Clock;
  private readonly onRequest: RefreshSchedulerOptions["onRequest"];
  private readonly timers: TimerDriver;
  private intervalMilliseconds: number;
  private running = false;
  private deadline: number | undefined;
  private timerHandle: unknown;
  private timerToken = 0;

  constructor(options: RefreshSchedulerOptions) {
    if (!Number.isFinite(options.refreshIntervalSeconds ?? DEFAULT_REFRESH_INTERVAL_SECONDS)) {
      throw new RangeError("refreshIntervalSeconds must be finite");
    }

    const intervalSeconds = options.refreshIntervalSeconds ?? DEFAULT_REFRESH_INTERVAL_SECONDS;
    if (intervalSeconds < 0) {
      throw new RangeError("refreshIntervalSeconds must be non-negative");
    }

    this.clock = options.clock;
    this.onRequest = options.onRequest;
    this.timers = options.timers ?? systemTimers;
    this.intervalMilliseconds = intervalSeconds * 1000;
  }

  get refreshIntervalSeconds(): number {
    return this.intervalMilliseconds / 1000;
  }

  setRefreshIntervalSeconds(seconds: number): void {
    if (!Number.isFinite(seconds)) {
      throw new RangeError("refreshIntervalSeconds must be finite");
    }
    if (seconds < 0 || !Number.isSafeInteger(seconds)) {
      throw new RangeError("refreshIntervalSeconds must be a non-negative integer");
    }
    const nextMilliseconds = seconds * 1000;
    if (nextMilliseconds === this.intervalMilliseconds) return;
    this.intervalMilliseconds = nextMilliseconds;
    if (this.running) {
      this.resetDeadline();
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.resetDeadline();
  }

  stop(): void {
    this.running = false;
    this.deadline = undefined;
    this.timerToken += 1;
    this.clearTimer();
  }

  /** Trigger an immediate refresh and restart the automatic cadence. */
  manual(): void {
    if (!this.running) {
      return;
    }

    this.resetDeadline();
    this.onRequest("manual");
  }

  /** Treat wake as one invalidation, never as one callback per missed tick. */
  wake(): void {
    if (!this.running) {
      return;
    }

    this.resetDeadline();
    this.onRequest("wake");
  }

  nextRefreshAt(): number | undefined {
    return this.deadline;
  }

  countdownSeconds(): number | undefined {
    if (!this.running || this.deadline === undefined) {
      return undefined;
    }

    return Math.max(0, Math.ceil((this.deadline - this.clock.monotonicNow()) / 1000));
  }

  /** Reset the cadence after a completed refresh or an externally detected wake. */
  reset(): void {
    if (this.running) {
      this.resetDeadline();
    }
  }

  private resetDeadline(): void {
    this.timerToken += 1;
    this.clearTimer();

    if (this.intervalMilliseconds === 0) {
      this.deadline = undefined;
      return;
    }

    this.deadline = this.clock.monotonicNow() + this.intervalMilliseconds;
    const token = this.timerToken;
    this.timerHandle = this.timers.setTimeout(() => {
      if (!this.running || token !== this.timerToken) {
        return;
      }

      this.timerHandle = undefined;
      // Schedule from the current monotonic instant. This collapses delayed
      // callbacks after sleep instead of replaying every missed interval.
      this.resetDeadline();
      this.onRequest("timer");
    }, this.intervalMilliseconds);
  }

  private clearTimer(): void {
    if (this.timerHandle !== undefined) {
      this.timers.clearTimeout(this.timerHandle);
      this.timerHandle = undefined;
    }
  }
}
