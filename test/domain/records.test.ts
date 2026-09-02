import assert from "node:assert/strict";
import test from "node:test";
import {
  createUsageRecord,
  createUsageWindow,
  stableRecordKey,
  sumUsageRecords,
  tokenRevisionFor,
  usageRecordKey,
  type UsageRecordInput,
} from "../../src/domain/index.js";

const tokens = {
  input: 10,
  output: 20,
  reasoning: 3,
  cacheRead: 4,
  cacheWrite: 5,
};

const recordInput = (overrides: Partial<UsageRecordInput> = {}): UsageRecordInput => ({
  sessionID: "ses-root",
  messageID: "msg-1",
  createdAt: new Date("2024-03-10T12:00:00.000Z"),
  model: "provider/model",
  tokens,
  observedAt: new Date("2024-03-10T12:01:00.000Z"),
  completeness: "final",
  ...overrides,
});

test("record keys are stable across observation changes and distinguish sessions", () => {
  assert.equal(usageRecordKey("ses-root", "msg-1"), "ses-root/msg-1");
  assert.equal(stableRecordKey("ses-root", "msg-1"), usageRecordKey("ses-root", "msg-1"));
  assert.notEqual(usageRecordKey("ses-root", "msg-1"), usageRecordKey("ses-child", "msg-1"));

  const first = createUsageRecord(recordInput());
  const laterObservation = createUsageRecord(
    recordInput({ observedAt: new Date("2024-03-10T12:05:00.000Z") }),
  );
  const revised = createUsageRecord(
    recordInput({ tokens: { ...tokens, output: 21 } }),
  );

  assert.equal(first.key, laterObservation.key);
  assert.equal(first.tokenRevision, laterObservation.tokenRevision);
  assert.notEqual(first.tokenRevision, revised.tokenRevision);
  assert.equal(first.recorded_total, 42);
});

test("record summing uses message creation time and excludes provisional by default", () => {
  const window = createUsageWindow(
    "day",
    new Date("2024-03-10T16:00:00.000Z"),
    "America/New_York",
  );
  const final = createUsageRecord(recordInput());
  const provisional = createUsageRecord(
    recordInput({ messageID: "msg-2", completeness: "provisional" }),
  );
  const outside = createUsageRecord(
    recordInput({ messageID: "msg-3", createdAt: new Date("2024-03-11T12:00:00.000Z") }),
  );

  assert.deepEqual(sumUsageRecords([final, provisional, outside], window), {
    input: 10,
    output: 20,
    reasoning: 3,
    cacheRead: 4,
    cacheWrite: 5,
    recorded_total: 42,
  });
  assert.equal(
    sumUsageRecords([final, provisional], window, { includeProvisional: true }).recorded_total,
    84,
  );
});

test("tokenRevisionFor is deterministic for equivalent normalized values", () => {
  assert.equal(tokenRevisionFor(tokens, "final"), tokenRevisionFor({ ...tokens }, "final"));
  assert.notEqual(tokenRevisionFor(tokens, "final"), tokenRevisionFor(tokens, "provisional"));
});

test("record IDs cannot make an ambiguous slash-delimited key", () => {
  assert.throws(() => usageRecordKey("ses/root", "msg-1"), /must not contain/);
  assert.throws(() => usageRecordKey("ses-root", "msg/1"), /must not contain/);
});
