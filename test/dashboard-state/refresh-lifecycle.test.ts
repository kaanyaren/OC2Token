import assert from "node:assert/strict";
import test from "node:test";
import type {
  CollectionRequest,
  CollectionResult,
  UsageWindow,
} from "../../src/domain/index.js";
import {
  RefreshCoordinator,
} from "../../src/dashboard/state/refresh-coordinator.js";
import type { Clock, RefreshRequest } from "../../src/dashboard/state/types.js";
import type { TimerDriver } from "../../src/dashboard/scheduler/refresh-scheduler.js";

class FakeClock implements Clock {
  wall = new Date("2026-01-05T12:00:00.000Z");
  monotonic = 0;

  wallNow(): Date {
    return new Date(this.wall.getTime());
  }

  monotonicNow(): number {
    return this.monotonic;
  }

  advance(milliseconds: number, moveWall = true): void {
    this.monotonic += milliseconds;
    if (moveWall) this.wall = new Date(this.wall.getTime() + milliseconds);
  }

  jumpWall(milliseconds: number): void {
    this.wall = new Date(this.wall.getTime() + milliseconds);
  }
}

class FakeTimers implements TimerDriver {
  private nextID = 1;
  private readonly timers = new Map<number, { readonly due: number; readonly callback: () => void }>();

  constructor(private readonly clock: FakeClock) {}

  setTimeout(callback: () => void, delayMilliseconds: number): number {
    const id = this.nextID++;
    this.timers.set(id, {
      due: this.clock.monotonicNow() + delayMilliseconds,
      callback,
    });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get size(): number {
    return this.timers.size;
  }

  runDue(): void {
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= this.clock.monotonicNow())
        .sort(([, left], [, right]) => left.due - right.due)[0];
      if (due === undefined) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

class DeferredSource {
  readonly calls: RefreshRequest[] = [];
  readonly pending: Deferred<CollectionResult>[] = [];
  abortRequests = false;

  collect(request: CollectionRequest): Promise<CollectionResult> {
    const refreshRequest = request as RefreshRequest;
    this.calls.push(refreshRequest);
    const result = deferred<CollectionResult>();
    this.pending.push(result);
    if (this.abortRequests) {
      refreshRequest.signal.addEventListener("abort", () => result.reject(new Error("aborted")), { once: true });
    }
    return result.promise;
  }
}

function resultFor(request: RefreshRequest, marker: number): CollectionResult {
  const windows: ReadonlyArray<UsageWindow> = request.windows;
  return {
    capturedAt: request.capturedAt,
    windows,
    source: "message-scan",
    records: [],
    totalsByWindow: {},
    coverage: {
      complete: true,
      sessionsDiscovered: 0,
      sessionsScanned: 0,
      sessionsSkipped: 0,
      pagesRead: marker,
      jobsRetried: 0,
      provisionalMessages: 0,
      errors: [],
    },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function setup(refreshIntervalSeconds = 300) {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const source = new DeferredSource();
  const coordinator = new RefreshCoordinator({
    source,
    clock,
    timezone: "UTC",
    refreshIntervalSeconds,
    timers,
    initialPeriod: "week",
    initialNavigation: { panel: "models", index: 2, scrollOffset: 0 },
  });
  return { clock, timers, source, coordinator };
}

test("initial load is immediate and timer/manual/wake requests are single-flight", async () => {
  const { source, coordinator } = setup();
  const initial = coordinator.start();
  await flush();
  assert.equal(source.calls.length, 1);
  assert.equal(source.calls[0].reason, "initial");

  const timer = coordinator.request("timer");
  const manual = coordinator.refresh();
  const wake = coordinator.wake();
  await flush();
  assert.equal(source.calls.length, 1);
  assert.equal(coordinator.getState().pendingReason, "manual");

  source.pending[0].resolve(resultFor(source.calls[0], 1));
  assert.equal((await initial).kind, "committed");
  await flush();
  assert.equal(source.calls.length, 2);
  assert.equal(source.calls[1].reason, "manual");
  source.pending[1].resolve(resultFor(source.calls[1], 2));
  assert.equal((await manual).kind, "committed");
  assert.equal((await timer).kind, "committed");
  assert.equal((await wake).kind, "committed");
  assert.equal(source.calls.length, 2);
});

test("failed refresh retains the last good snapshot and manual retry is allowed", async () => {
  const { source, coordinator } = setup();
  const initial = coordinator.start();
  await flush();
  source.pending[0].resolve(resultFor(source.calls[0], 7));
  await initial;
  await flush();
  const good = coordinator.getState().snapshot;

  const retry = coordinator.refresh();
  await flush();
  source.pending[1].reject(new Error("service unavailable"));
  const outcome = await retry;
  assert.equal(outcome.kind, "failed");
  const state = coordinator.getState();
  assert.equal(state.status, "error");
  assert.equal(state.stale, true);
  assert.deepEqual(state.snapshot, good);
  assert.deepEqual(state.lastGoodSnapshot, good);
});

test("quit aborts active work, stops the timer, and discards a late completion", async () => {
  const { source, timers, coordinator } = setup();
  source.abortRequests = true;
  const initial = coordinator.start();
  await flush();
  assert.equal(timers.size, 1);
  const quitting = coordinator.quit();
  await quitting;
  assert.equal(coordinator.getState().status, "stopped");
  assert.equal(coordinator.isStopped, true);
  assert.equal(timers.size, 0);
  source.pending[0].resolve(resultFor(source.calls[0], 99));
  assert.equal((await initial).kind, "cancelled");
  assert.equal(coordinator.getState().snapshot, undefined);
});

test("countdown uses monotonic time even when wall time jumps", async () => {
  const { clock, timers, source, coordinator } = setup();
  const initial = coordinator.start();
  await flush();
  source.pending[0].resolve(resultFor(source.calls[0], 1));
  await initial;
  await flush();
  assert.equal(coordinator.getState().countdownSeconds, 300);

  clock.jumpWall(86_400_000);
  assert.equal(coordinator.getState().countdownSeconds, 300);
  clock.advance(1_001, false);
  assert.equal(coordinator.getState().countdownSeconds, 299);
  timers.runDue();
  await flush();
  assert.equal(source.calls.length, 1);
});

test("automatic timer fires once after 300 seconds and refreshInterval=0 is manual-only", async () => {
  const setupWithTimer = setup();
  const initial = setupWithTimer.coordinator.start();
  await flush();
  setupWithTimer.source.pending[0].resolve(resultFor(setupWithTimer.source.calls[0], 1));
  await initial;
  await flush();
  setupWithTimer.clock.advance(300_000);
  setupWithTimer.timers.runDue();
  await flush();
  assert.equal(setupWithTimer.source.calls.length, 2);
  assert.equal(setupWithTimer.source.calls[1].reason, "timer");

  const manualOnly = setup(0);
  const manualInitial = manualOnly.coordinator.start();
  await flush();
  manualOnly.source.pending[0].resolve(resultFor(manualOnly.source.calls[0], 1));
  await manualInitial;
  await flush();
  manualOnly.clock.advance(3_600_000);
  manualOnly.timers.runDue();
  assert.equal(manualOnly.source.calls.length, 1);
  assert.equal(manualOnly.coordinator.getState().countdownSeconds, undefined);
  const manual = manualOnly.coordinator.refresh();
  await flush();
  assert.equal(manualOnly.source.calls.length, 2);
  manualOnly.source.pending[1].resolve(resultFor(manualOnly.source.calls[1], 2));
  assert.equal((await manual).kind, "committed");
});

test("period and navigation survive every refresh transition", async () => {
  const { source, coordinator } = setup();
  const initial = coordinator.start();
  coordinator.setPeriod("hour");
  coordinator.setNavigation({ panel: "providers", index: 9, scrollOffset: 4 });
  await flush();
  source.pending[0].resolve(resultFor(source.calls[0], 1));
  await initial;
  await flush();
  const refresh = coordinator.refresh();
  await flush();
  source.pending[1].resolve(resultFor(source.calls[1], 2));
  await refresh;
  const state = coordinator.getState();
  assert.equal(state.period, "hour");
  assert.deepEqual(state.navigation, { panel: "providers", index: 9, scrollOffset: 4 });
});
