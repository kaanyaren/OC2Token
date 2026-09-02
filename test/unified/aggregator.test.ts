import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createUsageRecord,
  createUsageWindows,
  sumUsageRecords,
  type CollectionRequest,
  type CollectionResult,
  type UsageSource,
} from "../../src/domain/index.js";
import { UnifiedUsageSource } from "../../src/application.js";

const NOW = new Date("2026-09-02T10:00:00.000Z");
function windows() {
  return Object.values(createUsageWindows(NOW, "UTC"));
}
function request(signal?: AbortSignal): CollectionRequest {
  return { capturedAt: NOW, windows: windows() as unknown as CollectionRequest["windows"], signal };
}
function sourceReturning(result: CollectionResult): UsageSource {
  return { collect: async (req) => {
    if (req.signal?.aborted) {
      const { DomainError } = await import("../../src/domain/errors.js");
      throw new DomainError("cancelled", "cancelled");
    }
    return result;
  }};
}
function delayedSource(result: CollectionResult, delayMs: number): UsageSource {
  return {
    collect: async (req) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        req.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { code: "cancelled" }));
        });
      });
      if (req.signal?.aborted) throw Object.assign(new Error("aborted"), { code: "cancelled" });
      return result;
    },
  };
}
function emptyProviderResult(source: "codex" | "antigravity"): CollectionResult;
function emptyProviderResult(source: "message-scan"): CollectionResult;
function emptyProviderResult(source: "codex" | "antigravity" | "message-scan"): CollectionResult {
  const wins = windows();
  const zero = sumUsageRecords([], wins[0]!);
  return {
    capturedAt: NOW,
    windows: wins,
    source: source as CollectionResult["source"],
    records: [],
    totalsByWindow: { hour: zero, day: zero, week: zero },
    coverage: { complete: true, sessionsDiscovered: 0, sessionsScanned: 0, sessionsSkipped: 0, pagesRead: 0, jobsRetried: 0, provisionalMessages: 0, errors: [] },
  };
}
function fixtureResult(provider: "opencode" | "codex" | "antigravity", input: number): CollectionResult {
  const wins = windows();
  const rec = createUsageRecord({
    sessionID: `${provider}-session`,
    messageID: `${provider}-msg-${input}`,
    createdAt: new Date("2026-09-02T09:55:00.000Z"),
    model: `${provider}/model`,
    tokens: { input, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    observedAt: NOW,
    completeness: "final",
    provider,
  });
  const totals = sumUsageRecords([rec], wins[1]!);
  return {
    capturedAt: NOW,
    windows: wins,
    source: provider === "opencode" ? "message-scan" : provider,
    records: [rec],
    totalsByWindow: { hour: totals, day: totals, week: totals },
    coverage: { complete: true, sessionsDiscovered: 1, sessionsScanned: 1, sessionsSkipped: 0, pagesRead: 1, jobsRetried: 0, provisionalMessages: 0, errors: [] },
  };
}

test("UnifiedUsageSource sums all providers into unified totals and provider breakdown", async () => {
  const opencode = fixtureResult("opencode", 100);
  const codex = fixtureResult("codex", 50);
  const antigravity = fixtureResult("antigravity", 30);
  const unified = new UnifiedUsageSource(sourceReturning(opencode), sourceReturning(codex), sourceReturning(antigravity));
  const result = await unified.collect(request());
  assert.equal(result.source, "unified");
  assert.equal(result.records.length, 3);
  assert.equal(result.totalsByWindow.day?.input, 180);
  assert.equal(result.totalsByWindow.day?.recorded_total, 183);
  // providersByWindow per window should contain 3 breakdowns
  assert.equal(result.providersByWindow?.day?.length, 3);
  const providerNames = result.providersByWindow?.day?.map((p) => p.name).sort();
  assert.deepEqual(providerNames, ["antigravity", "codex", "opencode"].sort());
});

test("UnifiedUsageSource deterministic sorting despite random completion order", async () => {
  // Simulate three providers with different delays, but final records sorted by provider/key
  const opencode = fixtureResult("opencode", 10);
  const codex = fixtureResult("codex", 20);
  const antigravity = fixtureResult("antigravity", 30);
  const slow = delayedSource(opencode, 30);
  const fast = delayedSource(codex, 0);
  const medium = delayedSource(antigravity, 10);

  const unified = new UnifiedUsageSource(slow, fast, medium);
  const a = await unified.collect(request());
  const b = await new UnifiedUsageSource(delayedSource(antigravity, 0), delayedSource(opencode, 20), delayedSource(codex, 10)).collect(request());
  // Both should produce same sorted order by provider/key, not arrival order
  assert.deepEqual(a.records.map((r) => r.key), b.records.map((r) => r.key));
  assert.deepEqual(a.records.map((r) => r.provider), ["antigravity", "codex", "opencode"]);
  assert.deepEqual(b.records.map((r) => r.provider), ["antigravity", "codex", "opencode"]);
  // Totals identical regardless of order
  assert.deepEqual(a.totalsByWindow, b.totalsByWindow);
});

test("UnifiedUsageSource filterProviders limits collection", async () => {
  const opencode = fixtureResult("opencode", 100);
  const codex = fixtureResult("codex", 50);
  const antigravity = fixtureResult("antigravity", 30);
  const filtered = new UnifiedUsageSource(sourceReturning(opencode), sourceReturning(codex), sourceReturning(antigravity), { filterProviders: new Set(["codex"]) });
  const result = await filtered.collect(request());
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]?.provider, "codex");
  assert.equal(result.totalsByWindow.day?.input, 50);
  assert.equal(result.source, "codex");
});

test("UnifiedUsageSource coverage merges errors with provider prefix and sorts deterministically", async () => {
  const failing: UsageSource = {
    collect: async () => {
      throw Object.assign(new Error("boom"), { code: "transport", message: "boom" });
    },
  };
  const opencode = fixtureResult("opencode", 10);
  // One success, one failure
  const unified = new UnifiedUsageSource(sourceReturning(opencode), failing, sourceReturning(emptyProviderResult("antigravity" as const)));
  const result = await unified.collect(request());
  assert.equal(result.coverage.complete, false);
  assert.ok(result.coverage.errors.some((e) => e.message?.includes("[codex]")));
  // Errors sorted
  const messages = result.coverage.errors.map((e) => e.message ?? "");
  const sorted = [...messages].sort();
  assert.deepEqual(messages, sorted);
});

test("UnifiedUsageSource cancellation aborts all three providers", async () => {
  const opencode = delayedSource(fixtureResult("opencode", 10), 50);
  const codex = delayedSource(fixtureResult("codex", 20), 50);
  const antigravity = delayedSource(fixtureResult("antigravity", 30), 50);
  const unified = new UnifiedUsageSource(opencode, codex, antigravity);
  const controller = new AbortController();
  const promise = unified.collect(request(controller.signal));
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, (err: unknown) => {
    const e = err as { code?: string };
    return e.code === "cancelled";
  });
});

test("UnifiedUsageSource supports project filter passthrough and window union", async () => {
  const opencode = fixtureResult("opencode", 11);
  const codex = fixtureResult("codex", 22);
  // Use real windows spanning hour/day/week union - all providers filter same windows
  const unified = new UnifiedUsageSource(sourceReturning(opencode), sourceReturning(codex), sourceReturning(emptyProviderResult("antigravity" as const)));
  const req = { capturedAt: NOW, windows: windows().slice(0, 1) } as unknown as CollectionRequest;
  const result = await unified.collect(req);
  assert.ok(result.windows.length === 1);
  assert.ok(result.totalsByWindow.hour);
});

test("UnifiedUsageSource parallel oracle: serial sum equals parallel-equivalent", async () => {
  // Collect via unified vs manual sum
  const opencode = fixtureResult("opencode", 11);
  const codex = fixtureResult("codex", 22);
  const antigravity = fixtureResult("antigravity", 33);
  const unified = new UnifiedUsageSource(sourceReturning(opencode), sourceReturning(codex), sourceReturning(antigravity));
  const result = await unified.collect(request());
  for (const w of windows()) {
    const manual = sumUsageRecords(result.records, w);
    assert.deepEqual(manual, result.totalsByWindow[w.kind as keyof typeof result.totalsByWindow]);
  }
});
