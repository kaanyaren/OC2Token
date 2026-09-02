import assert from "node:assert/strict";
import test from "node:test";
import {
  createUsageRecord,
  createUsageWindows,
  toUsageTotals,
} from "../../src/domain/index.js";
import {
  ANSI,
  formatTokenCount,
  renderDashboard,
  renderInPlace,
  renderOutput,
  toJSONSnapshot,
  usageTotalsFrom,
} from "../../src/output/index.js";

const NOW = new Date("2026-09-02T10:00:00.000Z");

function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const windows = Object.values(createUsageWindows(NOW, "Europe/Istanbul"));
  const record = createUsageRecord({
    sessionID: "session-1",
    messageID: "message-1",
    createdAt: new Date("2026-09-02T09:55:00.000Z"),
    model: "openai/gpt-5",
    tokens: { input: 100, output: 20, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
    observedAt: NOW,
    completeness: "final",
  });
  const totals = toUsageTotals({ input: 100, output: 20, reasoning: 3, cacheRead: 4, cacheWrite: 5 });
  return {
    capturedAt: NOW,
    windows,
    source: "message-scan",
    serverVersion: "beta-18866",
    records: [record],
    totalsByWindow: { hour: totals, day: totals, week: totals },
    coverage: {
      complete: true,
      sessionsDiscovered: 1,
      sessionsScanned: 1,
      sessionsSkipped: 0,
      pagesRead: 1,
      jobsRetried: 0,
      provisionalMessages: 0,
      errors: [],
    },
    nextRefreshAt: new Date("2026-09-02T10:05:00.000Z"),
    ...overrides,
  };
}

test("formatting recomputes recorded_total from all five components", () => {
  assert.deepEqual(
    usageTotalsFrom({ input: 100, output: 20, reasoning: 3, cache: { read: 4, write: 5 }, recorded_total: 999 }),
    { input: 100, output: 20, reasoning: 3, cacheRead: 4, cacheWrite: 5, recorded_total: 132 },
  );
  assert.equal(formatTokenCount(1_234), "1.2K");
});

test("JSON emits exact windows and stable metadata", () => {
  const json = toJSONSnapshot(fixture());
  assert.deepEqual(Object.keys(json), [
    "schemaVersion", "windows", "source", "version", "lastUpdated",
    "nextRefreshAt", "stale", "coverage", "totals", "trends", "models", "providers",
  ]);
  assert.equal(json.windows.day.from, "2026-09-01T21:00:00.000Z");
  assert.equal(json.windows.week.to, "2026-09-06T21:00:00.000Z");
  assert.equal(json.source, "message-scan");
  assert.equal(json.version, "beta-18866");
  assert.equal(json.lastUpdated, "2026-09-02T10:00:00.000Z");
  assert.equal(json.nextRefreshAt, "2026-09-02T10:05:00.000Z");
  assert.equal(json.totals.day.recorded_total, 132);
  assert.equal(json.models[0]?.name, "openai/gpt-5");
  assert.equal(json.providers[0]?.name, "openai");
});

test("partial and stale snapshots remain visibly honest", () => {
 const output = renderDashboard(fixture({
   stale: true,
    coverage: { complete: false, sessionsDiscovered: 1, sessionsScanned: 1, sessionsSkipped: 0, pagesRead: 1, jobsRetried: 0, provisionalMessages: 0, errors: [{ code: "transport", retryable: true }] },
  }), { isTTY: true, color: false, width: 100, now: NOW });
  assert.match(output, /Status: STALE/);
  assert.match(output, /1 error/);
  const json = toJSONSnapshot(fixture({ stale: true }));
  assert.equal(json.stale, true);
  assert.equal(json.coverage.complete, false);
});

test("narrow dashboard uses one column and contains the navigation footer", () => {
  const output = renderDashboard(fixture(), { isTTY: true, color: false, width: 60, now: NOW });
  const cardRows = output.split("\n").filter((line) => line.startsWith("┌"));
  assert.equal(cardRows.length, 3);
  assert.ok(cardRows.every((line) => !line.includes("┐  ┌")));
  assert.match(output, /r Refresh/);
  assert.doesNotMatch(output, /\u001b\[/);
});

test("piped auto output is plain table and redraw is in-place ANSI only", () => {
  const piped = renderOutput(fixture(), { isTTY: false });
  assert.match(piped, /Window.*Recorded/);
  assert.doesNotMatch(piped, /\u001b\[/);
  const frame = renderInPlace("one\ntwo", 3, { isTTY: true, ansi: true, color: false });
  assert.ok(frame.startsWith(ANSI.cursorHome));
  assert.ok(frame.includes(ANSI.clearLine));
  assert.doesNotMatch(frame, /\u001b\[2J/);
});

test("safe labels cannot inject terminal controls or line breaks", () => {
  const output = renderDashboard(fixture({
    models: [{ name: "prompt\n\u001b[31msecret", totals: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }],
  }), { isTTY: true, color: false, width: 100 });
  assert.doesNotMatch(output, /\u001b\[/);
  assert.doesNotMatch(output, /prompt\n/);
  assert.match(output, /prompt_secret/);
});
