import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AgyTpsAggregator,
  createAntigravityLiveTpsMeter,
  discoverAntigravityBrainDir,
} from "../../src/antigravity/live.js";

const NOW = 1_700_000_000_000;

function stepLine(
  type: string,
  createdAtMs: number,
  outputTokens?: number,
): string {
  return JSON.stringify({
    type,
    created_at: new Date(createdAtMs).toISOString(),
    ...(outputTokens === undefined ? {} : { output_tokens: outputTokens }),
  });
}

test("estimates agy TPS from PLANNER_RESPONSE output_tokens and elapsed step duration", () => {
  const aggregator = new AgyTpsAggregator();

  aggregator.ingestLine("sess-a", stepLine("GENERIC", NOW - 4_000), NOW - 4_000);
  aggregator.ingestLine("sess-a", stepLine("PLANNER_RESPONSE", NOW, 400), NOW);

  assert.deepEqual(aggregator.snapshot(NOW), { tps: 100, activeSessions: 1 });
  assert.deepEqual(aggregator.snapshot(NOW + 4_999), { tps: 100, activeSessions: 1 });
  assert.deepEqual(aggregator.snapshot(NOW + 5_000), { tps: 0, activeSessions: 0 });
});

test("sums concurrent agy sessions and tracks 10-minute average", () => {
  const aggregator = new AgyTpsAggregator();

  aggregator.ingestLine("sess-a", stepLine("GENERIC", NOW - 2_000), NOW - 2_000);
  aggregator.ingestLine("sess-a", stepLine("PLANNER_RESPONSE", NOW, 200), NOW);

  aggregator.ingestLine("sess-b", stepLine("USER_INPUT", NOW - 4_000), NOW - 4_000);
  aggregator.ingestLine("sess-b", stepLine("PLANNER_RESPONSE", NOW, 200), NOW);

  assert.deepEqual(aggregator.snapshot(NOW), { tps: 150, activeSessions: 2 });
  assert.equal(aggregator.averageTps(NOW), 400);
  assert.equal(aggregator.averageTps(NOW + 10_000), 40);
  assert.equal(aggregator.averageTps(NOW + 11 * 60_000), 0);
});

test("ignores malformed lines and non-positive output_tokens", () => {
  const aggregator = new AgyTpsAggregator();

  aggregator.ingestLine("sess-a", "not-json", NOW);
  aggregator.ingestLine("sess-a", JSON.stringify({ type: "PLANNER_RESPONSE", output_tokens: 0 }), NOW);
  aggregator.ingestLine("sess-a", JSON.stringify({ type: "PLANNER_RESPONSE", output_tokens: -5 }), NOW);
  aggregator.ingestLine("", stepLine("PLANNER_RESPONSE", NOW, 100), NOW);

  assert.deepEqual(aggregator.snapshot(NOW), { tps: 0, activeSessions: 0 });
});

test("createAntigravityLiveTpsMeter ignores pre-existing history and tails new lines", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc2-agy-live-"));
  try {
    const brainDir = join(root, ".gemini", "antigravity-cli", "brain");
    const sessDir = join(brainDir, "sess-1", ".system_generated", "logs");
    mkdirSync(sessDir, { recursive: true });
    const transcript = join(sessDir, "transcript.jsonl");

    // Pre-existing historical line should not spike live TPS on start.
    writeFileSync(transcript, stepLine("PLANNER_RESPONSE", NOW - 60_000, 5_000) + "\n");
    assert.equal(discoverAntigravityBrainDir(root), brainDir);

    let fakeNow = NOW;
    const meter = createAntigravityLiveTpsMeter({
      root,
      now: () => fakeNow,
      pollIntervalMs: 25,
    });
    meter.start();
    try {
      assert.deepEqual(meter.snapshot(), {
        available: true,
        tps: 0,
        activeSessions: 0,
        averageTps: 0,
      });

      // Append a tool step and a planner response 2s later.
      appendFileSync(transcript, stepLine("GENERIC", fakeNow) + "\n");
      fakeNow += 2_000;
      appendFileSync(transcript, stepLine("PLANNER_RESPONSE", fakeNow, 300) + "\n");

      // Wait briefly for watcher or fallback poll.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const snap = meter.snapshot();
      assert.equal(snap.available, true);
      assert.equal(snap.activeSessions, 1);
      assert.equal(snap.tps, 150);
    } finally {
      meter.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
