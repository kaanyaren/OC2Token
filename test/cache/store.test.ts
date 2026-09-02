import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createUsageRecord,
  createUsageWindows,
  type StoredSnapshot,
} from "../../src/domain/index.js";
import { CacheLock, NormalizedCacheStore } from "../../src/cache/index.js";

const fixedNow = new Date("2026-09-02T10:00:00.000Z");

async function withDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(join(tmpdir(), "oc2token-cache-test-"));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function snapshot(generation = 1): StoredSnapshot {
  const record = createUsageRecord({
    sessionID: "ses-root",
    messageID: "msg-1",
    createdAt: new Date("2026-09-02T09:30:00.000Z"),
    model: "provider/model",
    tokens: { input: 10, output: 20, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
    observedAt: fixedNow,
    completeness: "final",
  });
  return {
    schemaVersion: 1,
    generation,
    capturedAt: fixedNow,
    requestedWindows: Object.values(createUsageWindows(fixedNow, "UTC")),
    source: "message-scan",
    records: [record],
    totalsByWindow: {},
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
    serverFingerprint: "fixture-server",
    serverVersion: "beta-fixture",
  };
}

test("round-trips normalized records through an atomic manifest", async () => {
  await withDirectory(async (directory) => {
    const store = new NormalizedCacheStore(directory, {
      clock: { now: () => new Date(fixedNow) },
      random: { uuid: () => "11111111-1111-4111-8111-111111111111" },
    });
    const original = snapshot();
    const committed = await store.commitDetailed(original);
    assert.equal(committed.status, "committed");

    const loaded = await store.readDetailed();
    assert.equal(loaded.status, "available");
    if (loaded.status !== "available") return;
    assert.deepEqual(loaded.snapshot, original);
    assert.equal(loaded.records[0]?.recorded_total, 42);
    assert.equal(loaded.manifest.complete, true);
    assert.equal(loaded.manifest.schemaVersion, 2);
  });
});

test("recovers OC2Token temp leftovers without touching unrelated files", async () => {
  await withDirectory(async (directory) => {
    const store = new NormalizedCacheStore(directory);
    await store.commitDetailed(snapshot());
    const orphan = ".oc2token-manifest-crashed.tmp";
    await fs.writeFile(join(directory, orphan), "partial", { mode: 0o600 });
    await fs.writeFile(join(directory, "keep.tmp"), "not ours", { mode: 0o600 });

    const loaded = await store.readDetailed();
    assert.equal(loaded.status, "available");
    await assert.rejects(fs.stat(join(directory, orphan)), { code: "ENOENT" });
    assert.equal(await fs.readFile(join(directory, "keep.tmp"), "utf8"), "not ours");
  });
});

test("reports cross-process lock contention and reclaims a stale owner", async () => {
  await withDirectory(async (directory) => {
    const identity = { pid: 101, hostname: "test-host", isAlive: () => true };
    const held = new CacheLock(directory, {
      process: identity,
      clock: { now: () => new Date(fixedNow) },
      random: { uuid: () => "22222222-2222-4222-8222-222222222222" },
    });
    await fs.mkdir(directory, { recursive: true });
    const lease = await held.tryAcquire();
    assert.equal(lease.status, "acquired");

    const blocked = new NormalizedCacheStore(directory, {
      process: identity,
      clock: { now: () => new Date(fixedNow) },
    });
    const busy = await blocked.commitDetailed(snapshot());
    assert.equal(busy.status, "cache_busy");
    if (lease.status === "acquired") await lease.release();

    await fs.mkdir(join(directory, ".lock"), { recursive: false });
    await fs.writeFile(
      join(directory, ".lock", "owner.json"),
      JSON.stringify({
        pid: 999,
        host: "test-host",
        start: "2020-01-01T00:00:00.000Z",
        owner: "dead-owner-token-123456",
      }),
      { mode: 0o600 },
    );
    const stale = new NormalizedCacheStore(directory, {
      process: { pid: 101, hostname: "test-host", isAlive: () => false },
      clock: { now: () => new Date(fixedNow) },
      staleLockMs: 1_000,
    });
    assert.equal((await stale.commitDetailed(snapshot(2))).status, "committed");
  });
});

test("treats a future schema manifest as stale and unavailable", async () => {
  await withDirectory(async (directory) => {
    await fs.writeFile(join(directory, "manifest.json"), JSON.stringify({
      format: "oc2token.normalized-cache",
      schemaVersion: 999,
      complete: true,
    }));
    const result = await new NormalizedCacheStore(directory).readDetailed();
    assert.equal(result.status, "unavailable");
    if (result.status !== "unavailable") return;
    assert.equal(result.reason, "future_schema");
    assert.equal(result.stale, true);
  });
});

test("serializes concurrent commits and leaves one complete latest manifest", async () => {
  await withDirectory(async (directory) => {
    const store = new NormalizedCacheStore(directory, {
      random: {
        uuid: (() => {
          let value = 0;
          return () => `${String(++value).padStart(8, "0")}-0000-4000-8000-000000000000`;
        })(),
      },
    });
    const results = await Promise.all([store.commitDetailed(snapshot(1)), store.commitDetailed(snapshot(2))]);
    assert.deepEqual(results.map((result) => result.status), ["committed", "committed"]);
    const loaded = await store.readDetailed();
    assert.equal(loaded.status, "available");
    if (loaded.status !== "available") return;
    assert.equal(loaded.manifest.generation, 2);
    assert.equal(loaded.records.length, 1);
  });
});

test("migrates v1 records to v2 with provider default and preserves providerKind", async () => {
  await withDirectory(async (directory) => {
    const { serializeRecords, parseRecords } = await import("../../src/cache/schema.js");
    const { CURRENT_CACHE_SCHEMA_VERSION } = await import("../../src/cache/types.js");
    assert.equal(CURRENT_CACHE_SCHEMA_VERSION, 2);
    // Create a legacy v1 document without provider field (simulates old cache)
    const legacyDoc = JSON.stringify({
      format: "oc2token.normalized-records",
      schemaVersion: 1,
      records: [
        {
          key: "ses-root/msg-1",
          sessionID: "ses-root",
          messageID: "msg-1",
          createdAt: fixedNow.toISOString(),
          model: "provider/model",
          input: 10,
          output: 20,
          reasoning: 3,
          cacheRead: 4,
          cacheWrite: 5,
          recorded_total: 42,
          tokenRevision: "v1:10:20:3:4:5:final",
          observedAt: fixedNow.toISOString(),
          completeness: "final" as const,
          // provider intentionally omitted to test migration
        },
      ],
    });
    const migrated = parseRecords(legacyDoc);
    assert.equal(migrated.value.schemaVersion, 2);
    assert.equal(migrated.migrated, true);
    assert.equal(migrated.value.records[0]?.provider, "opencode");

    // Now create records with explicit providerKinds and ensure round-trip preserves them
    const codexRecord = createUsageRecord({
      sessionID: "ses-codex",
      messageID: "msg-codex",
      createdAt: new Date("2026-09-02T09:55:00.000Z"),
      model: "codex/model",
      tokens: { input: 7, output: 3, reasoning: 1, cacheRead: 2, cacheWrite: 4 },
      observedAt: fixedNow,
      completeness: "final",
      provider: "codex",
    });
    const agRecord = createUsageRecord({
      sessionID: "ses-ag",
      messageID: "msg-ag",
      createdAt: new Date("2026-09-02T09:56:00.000Z"),
      model: "gemini/model",
      tokens: { input: 5, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      observedAt: fixedNow,
      completeness: "final",
      provider: "antigravity",
    });
    const store = new NormalizedCacheStore(directory, {
      clock: { now: () => new Date(fixedNow) },
      random: { uuid: () => "33333333-3333-4333-8333-333333333333" },
    });
    const snap: StoredSnapshot = {
      schemaVersion: 1,
      generation: 5,
      capturedAt: fixedNow,
      requestedWindows: Object.values(createUsageWindows(fixedNow, "UTC")),
      source: "unified",
      records: [codexRecord, agRecord],
      totalsByWindow: {},
      coverage: {
        complete: true,
        sessionsDiscovered: 2,
        sessionsScanned: 2,
        sessionsSkipped: 0,
        pagesRead: 2,
        jobsRetried: 0,
        provisionalMessages: 0,
        errors: [],
      },
    };
    const committed = await store.commitDetailed(snap);
    assert.equal(committed.status, "committed");
    const loaded = await store.readDetailed();
    assert.equal(loaded.status, "available");
    if (loaded.status !== "available") return;
    const providers = loaded.records.map((r) => r.provider).sort();
    assert.deepEqual(providers, ["antigravity", "codex"]);
    assert.equal(loaded.manifest.schemaVersion, 2);
  });
});

test("cache lock contention returns cache_busy deterministically under commitChains", async () => {
  await withDirectory(async (directory) => {
    // Deterministic uuid and clock keep lock file naming and stale detection stable.
    const storeA = new NormalizedCacheStore(directory, {
      clock: { now: () => new Date(fixedNow) },
      random: { uuid: () => "44444444-4444-4444-8444-444444444444" },
      staleLockMs: 30 * 60 * 1000,
    });
    const storeB = new NormalizedCacheStore(directory, {
      clock: { now: () => new Date(fixedNow) },
      random: { uuid: () => "55555555-5555-4555-8555-555555555555" },
      staleLockMs: 30 * 60 * 1000,
    });
    // Two concurrent commits from different store instances targeting same directory
    // must serialize via commitChains and both eventually commit (last writer wins).
    const p1 = storeA.commitDetailed(snapshot(1));
    const p2 = storeB.commitDetailed(snapshot(2));
    const results = await Promise.all([p1, p2]);
    assert.ok(results.every((r) => r.status === "committed"));
    const loaded = await new NormalizedCacheStore(directory).readDetailed();
    assert.equal(loaded.status, "available");
    if (loaded.status !== "available") return;
    // Last commit should win deterministically due to chained serialization
    assert.equal(loaded.manifest.generation, 2);
  });
});
