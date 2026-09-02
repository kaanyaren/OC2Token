import assert from "node:assert/strict";
import test from "node:test";
import {
  collectUsageParallel,
  collectUsageSerial,
  type CollectionRequest,
  type MessagePage,
  type OpenCodeTransport,
  type SessionPage,
} from "../../src/collector/index.js";
import { createUsageWindow } from "../../src/domain/index.js";

const capturedAt = new Date("2026-09-02T01:00:00.000Z");
const windows = [createUsageWindow("hour", capturedAt, "UTC")];
const request = (signal?: AbortSignal): CollectionRequest => ({
  capturedAt,
  windows,
  signal,
});

type PageValue = unknown;

class FixtureTransport implements OpenCodeTransport {
  readonly sessionPage: SessionPage;
  readonly messagePages: Record<string, PageValue>;
  readonly calls: string[] = [];

  constructor(sessionPage: SessionPage, messagePages: Record<string, PageValue>) {
    this.sessionPage = sessionPage;
    this.messagePages = messagePages;
  }

  async listSessions(): Promise<SessionPage> {
    this.calls.push("sessions");
    return { ...this.sessionPage, nextCursor: this.sessionPage.nextCursor ?? null };
  }

  async listMessages(input: { sessionID: string; cursor?: string; signal: AbortSignal }): Promise<MessagePage> {
    this.calls.push(input.sessionID + ":" + (input.cursor ?? "first"));
    const value = this.messagePages[input.sessionID + ":" + (input.cursor ?? "first")];
    if (value instanceof Error) throw value;
    if (typeof value === "function") return (await value()) as MessagePage;
    if (value === undefined) throw new Error("missing fixture page");
    return value as MessagePage;
  }

  async getHealth(): Promise<{ version: string; fingerprint: string }> {
    return { version: "fixture", fingerprint: "fixture" };
  }

  async getSessionStats(): Promise<never> {
    throw new Error("stats are not used by the fallback collector");
  }
}

function message(id: string, input: number, revision: number, created = "2026-09-02T00:10:00Z") {
  return {
    id,
    type: "assistant",
    time: { created },
    model: { providerID: "test", id: "model" },
    tokenRevision: revision,
    tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

test("dedupes duplicate pages, replaces an older token revision, and includes child sessions", async () => {
  const transport = new FixtureTransport(
    { sessions: [{ sessionID: "root" }, { sessionID: "child", parentSessionID: "root" }, { sessionID: "root" }], nextCursor: null },
    {
      "root:first": {
        data: [message("m1", 1, 1)],
        nextCursor: "page-2",
      },
      "root:page-2": {
        data: [message("m1", 7, 2), message("m1", 2, 1)],
        nextCursor: null,
      },
      "child:first": {
        data: [{
          sessionID: "child",
          messageID: "child-message",
          createdAt: new Date("2026-09-02T00:10:00Z"),
          model: "test/model",
          completeness: "final",
          tokens: { input: 0, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        }],
        nextCursor: null,
      },
    },
  );

  const result = await collectUsageSerial(transport, request());
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.sessionsDiscovered, 2);
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map((record) => [record.sessionID, record.messageID, record.input, record.output]), [
    ["child", "child-message", 0, 3],
    ["root", "m1", 7, 0],
  ]);
  assert.equal(result.totalsByWindow.hour?.recorded_total, 10);
});

test("returns partial coverage for malformed and 404 session jobs without losing good sessions", async () => {
  let goodAttempts = 0;
  const transport = new FixtureTransport(
    { sessions: [{ sessionID: "bad" }, { sessionID: "missing" }, { sessionID: "good" }], nextCursor: null },
    {
      "bad:first": { data: "malformed" } as unknown as MessagePage,
      "missing:first": Object.assign(new Error("session not found"), { status: 404 }),
      "good:first": async () => {
        goodAttempts += 1;
        if (goodAttempts === 1) throw Object.assign(new Error("temporary outage"), { status: 503 });
        return { messages: [message("good-message", 4, 1)], nextCursor: null };
      },
    },
  );

  const result = await collectUsageParallel(transport, request(), { maxWorkers: 3, maxRetries: 1 });
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.sessionsScanned, 1);
  assert.equal(result.coverage.sessionsSkipped, 2);
  assert.equal(result.records.length, 1);
  assert.equal(result.coverage.jobsRetried, 1);
  assert.deepEqual(new Set(result.coverage.errors.map((error) => error.code)), new Set(["invalid-data", "transport"]));
});

test("rejects negative token components as partial invalid data rather than counting them", async () => {
  const transport = new FixtureTransport(
    { sessions: [{ sessionID: "negative" }], nextCursor: null },
    {
      "negative:first": {
        messages: [message("bad-token", -2, 1)],
        nextCursor: null,
      },
    },
  );

  const result = await collectUsageSerial(transport, request());
  assert.equal(result.records.length, 0);
  assert.equal(result.totalsByWindow.hour?.recorded_total, 0);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.errors[0]?.code, "invalid-data");
});

test("stops a session on a repeated message cursor instead of looping", async () => {
  const transport = new FixtureTransport(
    { sessions: [{ sessionID: "loop" }], nextCursor: null },
    {
      "loop:first": { messages: [message("once", 2, 1)], nextCursor: "same" },
      "loop:same": { messages: [], nextCursor: "same" },
    },
  );

  const result = await collectUsageSerial(transport, request());
  assert.equal(result.records.length, 1);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.errors[0]?.code, "protocol");
  assert.ok(transport.calls.length < 5);
});

test("parallel completion reordering produces the same canonical result as the serial oracle", async () => {
  const makeTransport = () => new FixtureTransport(
    { sessions: [{ sessionID: "slow" }, { sessionID: "fast" }], nextCursor: null },
    {
      "slow:first": async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { messages: [message("slow-message", 5, 1)], nextCursor: null };
      },
      "fast:first": async () => ({ messages: [message("fast-message", 9, 1)], nextCursor: null }),
    },
  );

  const serial = await collectUsageSerial(makeTransport(), request());
  const parallel = await collectUsageParallel(makeTransport(), request(), { maxWorkers: 2 });
  assert.deepEqual(parallel.records, serial.records);
  assert.deepEqual(parallel.totalsByWindow, serial.totalsByWindow);
});

test("propagates abort to the transport and rejects the collection", async () => {
  const controller = new AbortController();
  const transport = new FixtureTransport(
    { sessions: [{ sessionID: "blocked" }], nextCursor: null },
    {
      "blocked:first": () => new Promise<MessagePage>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    },
  );

  const collection = collectUsageParallel(transport, request(controller.signal));
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(collection, (error: unknown) =>
    error instanceof Error && "code" in error && (error as { code?: string }).code === "cancelled",
  );
});
