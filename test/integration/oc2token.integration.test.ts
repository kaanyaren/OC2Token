import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CachedUsageSource,
  HybridUsageSource,
  newCollectionRequest,
  UnifiedUsageSource,
} from "../../src/application.js";
import { CacheLock, NormalizedCacheStore } from "../../src/cache/index.js";
import {
  createUsageRecord,
  createUsageTrendBuckets,
  createUsageWindows,
  toUsageTotals,
  type CollectionRequest,
  type CollectionResult,
  type MessageListRequest,
  type MessagePage,
  type OpenCodeAssistantMessage,
  type OpenCodeSessionStats,
  type OpenCodeTransport,
  type SessionPage,
  type UsageSource,
  type UsageWindow,
  type UsageWindowKind,
} from "../../src/domain/index.js";
import {
  OpenCode2Adapter,
  OpenCodeStatsSource,
  StatsRangeMismatchError,
  type OpenCode2Adapter as OpenCode2AdapterType,
} from "../../src/opencode/index.js";
import { main } from "../../src/cli.js";
import { renderOutput } from "../../src/output/index.js";

const NOW = new Date("2026-09-02T10:00:00.000Z");

function request(): CollectionRequest {
  return newCollectionRequest(NOW, "UTC", { project: "fixture-project" });
}

function exactStats(window: UsageWindow, input: number): OpenCodeSessionStats {
  return {
    requestedWindow: window,
    reportedRange: {
      from: new Date(window.from.getTime()),
      to: new Date(window.to.getTime()),
      timezone: window.timezone,
    },
    totals: toUsageTotals({
      input,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  };
}

function assistant(
  sessionID: string,
  messageID: string,
  input: number,
  output = 0,
): OpenCodeAssistantMessage {
  return {
    sessionID,
    messageID,
    createdAt: new Date("2026-09-02T09:50:00.000Z"),
    model: "fixture/model",
    tokens: { input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    completeness: "final",
  };
}

class HybridFixtureTransport implements OpenCodeTransport {
  readonly statsCalls: UsageWindowKind[] = [];
  readonly trendCalls: UsageWindowKind[] = [];
  readonly sessionCalls: number[] = [];
  readonly messageCalls: string[] = [];

  constructor(readonly ignoreStatsAt?: UsageWindowKind) {}

  async getHealth(): Promise<{ version: string; fingerprint: string }> {
    return { version: "fixture-beta", fingerprint: "fixture-beta:123" };
  }

  async getSessionStats(window: UsageWindow): Promise<OpenCodeSessionStats> {
    const aggregate = createUsageWindows(NOW, window.timezone)[window.kind];
    const isAggregate = aggregate.from.getTime() === window.from.getTime() &&
      aggregate.to.getTime() === window.to.getTime();
    if (isAggregate) this.statsCalls.push(window.kind);
    else this.trendCalls.push(window.kind);
    if (isAggregate && window.kind === this.ignoreStatsAt) {
      throw new StatsRangeMismatchError(
        window,
        { from: new Date(0), to: new Date(NOW.getTime() + 1), timezone: window.timezone },
        true,
      );
    }
    return exactStats(window, isAggregate ? 100 + this.statsCalls.length : 1);
  }

  async listSessions(): Promise<SessionPage> {
    this.sessionCalls.push(this.sessionCalls.length + 1);
    return {
      sessions: [
        { sessionID: "root" },
        { sessionID: "child", parentSessionID: "root" },
      ],
      nextCursor: null,
    };
  }

  async listMessages(request: MessageListRequest): Promise<MessagePage> {
    this.messageCalls.push(request.sessionID);
    return {
      messages: request.sessionID === "root"
        ? [assistant("root", "root-message", 7)]
        : [assistant("child", "child-message", 0, 3)],
      nextCursor: null,
    };
  }
}

class ScopedBreakdownTransport extends HybridFixtureTransport {
  async getSessionStats(window: UsageWindow): Promise<OpenCodeSessionStats> {
    const result = await super.getSessionStats(window);
    const input = window.kind === "hour" ? 11 : window.kind === "day" ? 22 : 33;
    const providerInput = input + 10;
    const modelTotals = toUsageTotals({ input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    const providerTotals = toUsageTotals({ input: providerInput, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    return {
      ...result,
      models: [{ name: `${window.kind}-model`, provider: `${window.kind}-provider`, totals: modelTotals }],
      providers: [{ name: `${window.kind}-provider`, totals: providerTotals }],
    };
  }
}

class BoundedStatsTransport extends HybridFixtureTransport {
  active = 0;
  maxActive = 0;

  async getSessionStats(window: UsageWindow): Promise<OpenCodeSessionStats> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await super.getSessionStats(window);
    } finally {
      this.active -= 1;
    }
  }
}

function adapterFor(transport: OpenCodeTransport): OpenCode2AdapterType {
  const stats = new OpenCodeStatsSource(transport);
  const adapter = {
    transport,
    currentConnection: {
      health: { version: "fixture-beta", fingerprint: "fixture-beta:123" },
    },
    async connect(): Promise<never> {
      throw new Error("unexpected connection attempt in injected adapter fixture");
    },
    collect: (collectionRequest: CollectionRequest) => stats.collect(collectionRequest),
  };
  return adapter as unknown as OpenCode2AdapterType;
}

test("HybridUsageSource uses stats when every requested range is exact", async () => {
  const transport = new HybridFixtureTransport();
  const result = await new HybridUsageSource(adapterFor(transport)).collect(request());

  assert.equal(result.source, "stats");
  assert.equal(result.records.length, 0);
  assert.deepEqual(transport.statsCalls, ["hour", "day", "week"]);
  assert.deepEqual(transport.trendCalls, [
    ...Array.from({ length: 12 }, () => "hour" as const),
    ...Array.from({ length: 24 }, () => "day" as const),
    ...Array.from({ length: 7 }, () => "week" as const),
  ]);
  assert.equal(result.trendsByWindow?.hour?.length, 12);
  assert.equal(result.trendsByWindow?.day?.length, 24);
  assert.equal(result.trendsByWindow?.week?.length, 7);
  assert.equal(transport.sessionCalls.length, 0);
  assert.equal(result.totalsByWindow.hour?.recorded_total, 101);
  assert.equal(result.totalsByWindow.day?.recorded_total, 102);
  assert.equal(result.totalsByWindow.week?.recorded_total, 103);
  assert.equal(result.serverFingerprint, "fixture-beta:123");
});

test("OpenCodeStatsSource retains model/provider breakdowns for each window", async () => {
  const result = await new OpenCodeStatsSource(new ScopedBreakdownTransport()).collect(request());

  assert.equal(result.modelsByWindow?.hour?.[0]?.totals.recorded_total, 11);
  assert.equal(result.modelsByWindow?.day?.[0]?.totals.recorded_total, 22);
  assert.equal(result.modelsByWindow?.week?.[0]?.totals.recorded_total, 33);
  assert.equal(result.providersByWindow?.hour?.[0]?.totals.recorded_total, 21);
  assert.equal(result.providersByWindow?.day?.[0]?.totals.recorded_total, 32);
  assert.equal(result.providersByWindow?.week?.[0]?.totals.recorded_total, 43);
});

test("OpenCodeStatsSource bounds concurrent trend requests", async () => {
  const transport = new BoundedStatsTransport();
  const result = await new OpenCodeStatsSource(transport).collect(request());

  assert.equal(result.trendsByWindow?.day?.length, 24);
  assert.ok(transport.maxActive <= 4);
});

test("HybridUsageSource falls back for the whole refresh when stats ignores one range", async () => {
  const transport = new HybridFixtureTransport("day");
  const source = new HybridUsageSource(adapterFor(transport));

  const first = await source.collect(request());
  assert.equal(first.source, "message-scan");
  assert.equal(first.coverage.complete, true);
  assert.equal(first.records.length, 2);
  assert.equal(first.totalsByWindow.hour?.recorded_total, 10);
  assert.equal(first.totalsByWindow.day?.recorded_total, 10);
  assert.equal(first.totalsByWindow.week?.recorded_total, 10);
  assert.deepEqual(transport.statsCalls, ["hour", "day"]);
  assert.deepEqual(transport.messageCalls.sort(), ["child", "root"]);
  assert.equal(first.serverFingerprint, "fixture-beta:123");

  // The fingerprint remembers that this server cannot honor filtered stats;
  // the next refresh must go straight to the same complete message scan and
  // must not mix an old stats response with fallback totals.
  const statsCallsAfterFirst = transport.statsCalls.length;
  const second = await source.collect(request());
  assert.equal(second.source, "message-scan");
  assert.equal(second.totalsByWindow.day?.recorded_total, 10);
  assert.equal(transport.statsCalls.length, statsCallsAfterFirst);
  assert.equal(transport.sessionCalls.length, 2);
});

test("injected OpenCode2Adapter transport is usable by HybridUsageSource without connecting", async () => {
  const transport = new HybridFixtureTransport();
  const service = {
    async discover(): Promise<undefined> {
      throw new Error("connect should not be needed for an injected transport");
    },
    async ensure(): Promise<never> {
      throw new Error("connect should not be needed for an injected transport");
    },
    headers(): Record<string, string> | undefined {
      return undefined;
    },
  };
  const adapter = new OpenCode2Adapter({
    transport,
    service,
  });

  const result = await new HybridUsageSource(adapter).collect(request());
  assert.equal(result.source, "stats");
});

function partialResult(): CollectionResult {
  const windows = Object.values(createUsageWindows(NOW, "UTC"));
  const record = createUsageRecord({
    sessionID: "partial-session",
    messageID: "partial-message",
    createdAt: new Date("2026-09-02T09:50:00.000Z"),
    model: "fixture/model",
    tokens: { input: 7, output: 3, reasoning: 1, cacheRead: 2, cacheWrite: 4 },
    observedAt: NOW,
    completeness: "final",
  });
  const totals = toUsageTotals({ input: 7, output: 3, reasoning: 1, cacheRead: 2, cacheWrite: 4 });
  const dayBucket = createUsageTrendBuckets(windows[1]!)[0]!;
  return {
    capturedAt: NOW,
    windows,
    source: "message-scan",
    records: [record],
    totalsByWindow: { hour: totals, day: totals, week: totals },
    trendsByWindow: {
      day: [{ ...dayBucket, totals }],
    },
    coverage: {
      complete: false,
      sessionsDiscovered: 2,
      sessionsScanned: 1,
      sessionsSkipped: 1,
      pagesRead: 1,
      jobsRetried: 1,
      provisionalMessages: 0,
      errors: [{ code: "transport", message: "one session failed", sessionID: "failed-session", retryable: true }],
    },
    serverFingerprint: "fixture-beta:123",
    serverVersion: "fixture-beta",
  };
}

async function withDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(join(tmpdir(), "oc2token-integration-"));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function sourceReturning(result: CollectionResult): UsageSource {
  return { collect: async () => result };
}

function emptyProviderResult(source: "codex" | "antigravity"): CollectionResult {
  const windows = Object.values(createUsageWindows(NOW, "UTC"));
  const zero = toUsageTotals({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  return {
    capturedAt: NOW,
    windows,
    source,
    records: [],
    totalsByWindow: { hour: zero, day: zero, week: zero },
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

test("UnifiedUsageSource retains OpenCode stats totals and trends", async () => {
  const result = await new UnifiedUsageSource(
    new OpenCodeStatsSource(new HybridFixtureTransport()),
    sourceReturning(emptyProviderResult("codex")),
    sourceReturning(emptyProviderResult("antigravity")),
  ).collect(request());

  assert.equal(result.totalsByWindow.hour?.recorded_total, 101);
  assert.equal(result.totalsByWindow.day?.recorded_total, 102);
  assert.equal(result.trendsByWindow?.hour?.length, 12);
  assert.equal(result.trendsByWindow?.day?.length, 24);
  assert.equal(result.trendsByWindow?.week?.length, 7);
});

test("CachedUsageSource persists a partial result without presenting it as complete", async () => {
  await withDirectory(async (directory) => {
    const store = new NormalizedCacheStore(directory);
    const result = await new CachedUsageSource(sourceReturning(partialResult()), store).collect(request());

    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.errors[0]?.code, "transport");

    const loaded = await store.readDetailed();
    assert.equal(loaded.status, "available");
    if (loaded.status !== "available") return;
    assert.equal(loaded.snapshot.coverage.complete, false);
    assert.equal(loaded.snapshot.coverage.errors[0]?.code, "transport");
    assert.equal(loaded.snapshot.records[0]?.recorded_total, 17);
    assert.equal(loaded.snapshot.trendsByWindow?.day?.length, 1);
    assert.equal(loaded.snapshot.trendsByWindow?.day?.[0]?.totals.recorded_total, 17);
  });
});

test("CachedUsageSource keeps in-memory data and exposes cache_busy under lock contention", async () => {
  await withDirectory(async (directory) => {
    const held = await new CacheLock(directory).tryAcquire();
    assert.equal(held.status, "acquired");
    if (held.status !== "acquired") return;

    try {
      const result = await new CachedUsageSource(
        sourceReturning(partialResult()),
        new NormalizedCacheStore(directory),
      ).collect(request());

      assert.equal(result.records.length, 1);
      assert.equal(result.totalsByWindow.day?.recorded_total, 17);
      assert.equal(result.coverage.complete, false);
      const cacheError = result.coverage.errors.find((error) => error.code === "cache-busy");
      assert.ok(cacheError);
      assert.equal(cacheError?.retryable, true);

      const cached = await new NormalizedCacheStore(directory).readDetailed();
      assert.equal(cached.status, "empty");
    } finally {
      await held.release();
    }
  });
});

interface CapturedIO {
  readonly io: Parameters<typeof main>[1];
  readonly stdout: () => string;
  readonly stderr: () => string;
}

function capturedIO(): CapturedIO {
  let stdout = "";
  let stderr = "";
  const io = {
    stdin: { isTTY: false },
    stdout: {
      isTTY: false,
      write(value: string | Uint8Array): boolean {
        stdout += typeof value === "string" ? value : Buffer.from(value).toString("utf8");
        return true;
      },
    },
    stderr: {
      isTTY: false,
      write(value: string | Uint8Array): boolean {
        stderr += typeof value === "string" ? value : Buffer.from(value).toString("utf8");
        return true;
      },
    },
  } as unknown as Parameters<typeof main>[1];
  return { io, stdout: () => stdout, stderr: () => stderr };
}

test("CLI help and JSON parse errors are available offline", async () => {
  const help = capturedIO();
  assert.equal(await main(["--help"], help.io), 0);
  assert.match(help.stdout(), /oc2token 0\.1\.1/);
  assert.match(help.stdout(), /--refresh <seconds>/);
  assert.match(help.stdout(), /--timezone <IANA>/);
  assert.equal(help.stderr(), "");

  const version = capturedIO();
  assert.equal(await main(["--version"], version.io), 0);
  assert.equal(version.stdout(), "0.1.1\n");
  assert.equal(version.stderr(), "");

  const invalid = capturedIO();
  assert.equal(await main(["--json", "--refresh", "not-a-number"], invalid.io), 1);
  const payload = JSON.parse(invalid.stdout()) as { errorSchemaVersion: number; error: { code: string } };
  assert.equal(payload.errorSchemaVersion, 1);
  assert.equal(payload.error.code, "oc2token");
  assert.equal(invalid.stderr(), "");
});

test("explicit JSON output serializes an injected collection without network access", async () => {
  const transport = new HybridFixtureTransport();
  const result = await new HybridUsageSource(adapterFor(transport)).collect(request());
  const payload = JSON.parse(renderOutput(result, { format: "json", isTTY: false })) as {
    schemaVersion: number;
    source: string;
    windows: Record<string, { from: string; to: string; timezone: string }>;
    totals: Record<string, { recorded_total: number }>;
  };

  assert.equal(payload.schemaVersion, 4);
  assert.equal(payload.source, "stats");
  assert.equal(payload.windows.day.timezone, "UTC");
  assert.equal(payload.windows.hour.from, "2026-09-02T09:00:00.000Z");
  assert.equal(payload.totals.day.recorded_total, 102);
  assert.equal(transport.sessionCalls.length, 0);
});

test("format=json emits JSON for validation failures", async () => {
  const io = capturedIO();
  assert.equal(await main(["--format", "json", "--timezone", "Not/AZone"], io.io), 1);
  assert.match(io.stdout(), /^\{/);
  const payload = JSON.parse(io.stdout()) as { errorSchemaVersion: number; error: { code: string } };
  assert.equal(payload.errorSchemaVersion, 1);
  assert.equal(payload.error.code, "oc2token");
  assert.equal(io.stderr(), "");
});
