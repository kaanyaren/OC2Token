import assert from "node:assert/strict";
import test from "node:test";
import {
  type Clock,
  type OpenCodeTransport,
  type SessionPage,
  type SnapshotStore,
  type StoredSnapshot,
  type UsageSource,
} from "../../src/domain/index.js";

test("domain adapters can be dependency-injected without concrete services", async () => {
  const clock: Clock = {
    wallNow: () => new Date("2026-09-02T10:00:00.000Z"),
    monotonicNow: () => 1234,
  };
  const emptySessions: SessionPage = { sessions: [], nextCursor: null };
  const transport: OpenCodeTransport = {
    getHealth: async () => ({ version: "v2", fingerprint: "fixture" }),
    getSessionStats: async () => {
      throw new Error("not used by this fixture");
    },
    listSessions: async () => emptySessions,
    listMessages: async () => ({ messages: [], nextCursor: null }),
  };
  const store: SnapshotStore = {
    read: async () => null,
    commit: async (_snapshot: StoredSnapshot) => undefined,
  };
  const source: UsageSource = {
    collect: async (request) => ({
      capturedAt: request.capturedAt,
      windows: request.windows,
      source: "message-scan",
      records: [],
      totalsByWindow: {},
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
    }),
  };

  assert.equal(clock.monotonicNow(), 1234);
  assert.equal((await transport.getHealth()).fingerprint, "fixture");
  assert.equal((await store.read()), null);
  assert.equal((await source.collect({ capturedAt: clock.wallNow(), windows: [] })).coverage.complete, true);
});
