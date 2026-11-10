import assert from "node:assert/strict";
import test from "node:test";
import { TpsAggregator, type LiveTpsEvent } from "../../src/opencode/live.js";

const NOW = 1_000_000;

function event(type: string, data?: Record<string, unknown>): LiveTpsEvent {
  return { type, data };
}

function text(sessionID: string, length: number, type = "session.text.delta"): LiveTpsEvent {
  return event(type, { sessionID, delta: "x".repeat(length) });
}

test("sums heuristic tokens across sessions in the same window", () => {
  const aggregator = new TpsAggregator();

  aggregator.ingest(text("session-a", 40), NOW);
  aggregator.ingest(text("session-b", 40, "session.reasoning.delta"), NOW);

  assert.deepEqual(aggregator.snapshot(NOW), { tps: 20, activeSessions: 2 });
});

test("expires samples outside the rolling window", () => {
  const aggregator = new TpsAggregator();
  aggregator.ingest(text("session-a", 40), NOW);

  assert.deepEqual(aggregator.snapshot(NOW + 1_100), { tps: 0, activeSessions: 0 });
});

test("calibrates the heuristic factor from step token counts", () => {
  const aggregator = new TpsAggregator();

  aggregator.ingest(event("session.step.started", { sessionID: "session-a" }), NOW);
  aggregator.ingest(text("session-a", 40), NOW);
  aggregator.ingest(
    event("session.step.ended", {
      sessionID: "session-a",
      tokens: { output: 20, reasoning: 0 },
    }),
    NOW,
  );

  const next = NOW + 1_000;
  aggregator.ingest(event("session.step.started", { sessionID: "session-a" }), next);
  aggregator.ingest(text("session-a", 40), next);

  assert.deepEqual(aggregator.snapshot(next + 100), { tps: 20, activeSessions: 1 });
});

test("counts completed tool input once", () => {
  const aggregator = new TpsAggregator();
  const toolData = { sessionID: "session-a", id: "tool-1", assistantMessageID: "msg-1" };

  aggregator.ingest(event("session.tool.input.ended", { ...toolData, text: "x".repeat(40) }), NOW);
  assert.deepEqual(aggregator.snapshot(NOW), { tps: 10, activeSessions: 1 });

  const streamed = new TpsAggregator();
  streamed.ingest(event("session.tool.input.delta", { ...toolData, delta: "x".repeat(40) }), NOW);
  streamed.ingest(event("session.tool.input.ended", { ...toolData, text: "x".repeat(40) }), NOW);
  assert.deepEqual(streamed.snapshot(NOW), { tps: 10, activeSessions: 1 });
});

test("session.idle removes the session", () => {
  const aggregator = new TpsAggregator();
  aggregator.ingest(text("session-a", 40), NOW);

  aggregator.ingest(event("session.idle", { sessionID: "session-a" }), NOW);

  assert.deepEqual(aggregator.snapshot(NOW), { tps: 0, activeSessions: 0 });
});

test("tracks a 10-minute average and prunes older buckets", () => {
  const aggregator = new TpsAggregator();
  aggregator.ingest(text("session-a", 40), NOW);
  assert.equal(aggregator.averageTps(NOW), 10);

  aggregator.ingest(text("session-a", 40), NOW + 10_000);
  assert.equal(aggregator.averageTps(NOW + 10_000), 2);
  assert.equal(aggregator.averageTps(NOW + 11 * 60_000), 0);
});

test("ignores malformed events", () => {
  const aggregator = new TpsAggregator();

  assert.doesNotThrow(() => {
    aggregator.ingest({ type: "session.text.delta" }, NOW);
    aggregator.ingest({ type: "session.text.delta", data: {} }, NOW);
    aggregator.ingest({ type: "session.text.delta", data: { sessionID: "session-a" } }, NOW);
    aggregator.ingest({ type: "session.tool.input.ended", data: { sessionID: "session-a" } }, NOW);
  });

  assert.deepEqual(aggregator.snapshot(NOW), { tps: 0, activeSessions: 0 });
});
