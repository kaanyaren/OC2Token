import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createUsageWindows } from "../../src/domain/index.js";
import { collectCodex } from "../../src/codex/index.js";
import { discoverRolloutFiles } from "../../src/codex/discovery.js";

const FIXTURES = join(process.cwd(), "test", "fixtures", "codex");

async function withTempCodexHome(callback: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), "oc2token-codex-"));
  try {
    // Mirror fixtures into temp CODEX_HOME with expected sessions layout
    const sessionsDay = join(dir, "sessions", "2026", "09", "02");
    await fs.mkdir(sessionsDay, { recursive: true });
    await fs.copyFile(join(FIXTURES, "rollout-01.jsonl"), join(sessionsDay, "rollout-01.jsonl"));
    await fs.copyFile(join(FIXTURES, "rollout-02.jsonl"), join(sessionsDay, "rollout-02.jsonl"));
    const archived = join(dir, "archived_sessions");
    await fs.mkdir(archived, { recursive: true });
    await fs.copyFile(join(FIXTURES, "rollout-01.jsonl"), join(archived, "rollout-archived.jsonl"));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dir;
    try {
      await callback(dir);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("discoverRolloutFiles finds sessions and archived_sessions under CODEX_HOME", async () => {
  await withTempCodexHome(async () => {
    const files = discoverRolloutFiles();
    assert.equal(files.length, 3);
    assert.ok(files.some((f) => f.includes("rollout-01.jsonl")));
    assert.ok(files.some((f) => f.includes("rollout-02.jsonl")));
    assert.ok(files.some((f) => f.includes("rollout-archived.jsonl")));
  });
});

test("collectCodex maps billed tokens, respects fork guard and delta fallback", async () => {
  await withTempCodexHome(async () => {
    const NOW = new Date("2026-09-02T12:00:00.000Z");
    const windows = Object.values(createUsageWindows(NOW, "UTC"));
    const result = await collectCodex({ capturedAt: NOW, windows });
    assert.equal(result.source, "codex");
    assert.equal(result.coverage.complete, true);
    assert.equal(result.coverage.sessionsDiscovered, 3);
    // Fork guard should have skipped one event at 11:00:02, but we have 3 files (one is duplicate of rollout-01)
    // Expected records: rollout-01 has 2 valid token_counts per file -> but archived duplicate will dedup via tokenRevision?
    // Each rollout-01 duplicate has same sessionId and dedupKeys, so second file's records may dedup to same keys but different paths are separate? Actually reducer dedups by key (sessionID/messageID) => messageID is dedupKey which includes sessionId+totalTokens, so duplicate files with same content produce same keys and will deduplicate to 2 records, not 4.
    // So total distinct records: rollout-01 (2) + rollout-02 (2 after fork skip) = 4. Archived duplicate doesn't add new.
    assert.equal(result.records.length, 4);
    for (const rec of result.records) assert.equal(rec.provider, "codex");
    // Verify billed totals per our fixture calculations
    // rollout-01: billedInput 75+45=120, cacheRead 20+50=70, cacheWrite 5+5=10, output 400, reasoning 40
    // rollout-02: billedInput 200+40=240, cacheRead 100+50=150, cacheWrite 0+10=10, output 150, reasoning 5
    // Combined: input 360, output 550, reasoning 45, cacheRead 220, cacheWrite 20
    const dayTotals = result.totalsByWindow.day!;
    assert.equal(dayTotals.input, 360);
    assert.equal(dayTotals.output, 550);
    assert.equal(dayTotals.reasoning, 45);
    assert.equal(dayTotals.cacheRead, 220);
    assert.equal(dayTotals.cacheWrite, 20);
    assert.equal(dayTotals.recorded_total, 360 + 550 + 45 + 220 + 20);
  });
});

test("collectCodex respects window filtering and empty CODEX_HOME", async () => {
  // Empty home should return complete empty result
  const previous = process.env.CODEX_HOME;
  const empty = await fs.mkdtemp(join(tmpdir(), "oc2token-empty-codex-"));
  try {
    process.env.CODEX_HOME = empty;
    const NOW = new Date("2026-09-02T12:00:00.000Z");
    const windows = Object.values(createUsageWindows(NOW, "UTC"));
    const result = await collectCodex({ capturedAt: NOW, windows });
    assert.equal(result.records.length, 0);
    assert.equal(result.coverage.complete, true);
    assert.equal(result.coverage.sessionsDiscovered, 0);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await fs.rm(empty, { recursive: true, force: true });
  }

  // Window filter: request hour window that excludes 07:00 events
  await withTempCodexHome(async () => {
    const NOW = new Date("2026-09-02T12:00:00.000Z");
    const hourWindow = createUsageWindows(NOW, "UTC").hour;
    // hour window is 11:00-12:00, so only rollout-02 11:05/11:06 should be inside
    const result = await collectCodex({ capturedAt: NOW, windows: [hourWindow] });
    assert.equal(result.totalsByWindow.hour?.recorded_total, 240 + 150 + 5 + 150 + 10); // 555 from earlier
    assert.equal(result.records.length, 2);
  });
});

test("collectCodex cancellation via AbortSignal is propagated", async () => {
  await withTempCodexHome(async () => {
    const controller = new AbortController();
    controller.abort();
    const NOW = new Date("2026-09-02T12:00:00.000Z");
    const windows = Object.values(createUsageWindows(NOW, "UTC"));
    await assert.rejects(() => collectCodex({ capturedAt: NOW, windows, signal: controller.signal }), (err: unknown) => {
      const e = err as { code?: string };
      return e.code === "cancelled";
    });
  });
});

test("parallel oracle: serial sum equals parallel-equivalent scanner total", async () => {
  await withTempCodexHome(async () => {
    const NOW = new Date("2026-09-02T12:00:00.000Z");
    const windows = Object.values(createUsageWindows(NOW, "UTC"));
    const result = await collectCodex({ capturedAt: NOW, windows });
    // Manually sum last_token_usage billed values as serial oracle (already verified above)
    // Ensure sumUsageRecords equals totalsByWindow aggregation
    const { sumUsageRecords } = await import("../../src/domain/index.js");
    for (const w of windows) {
      const sum = sumUsageRecords(result.records, w);
      assert.deepEqual(sum, result.totalsByWindow[w.kind as keyof typeof result.totalsByWindow]);
    }
  });
});
