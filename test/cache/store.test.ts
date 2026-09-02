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
    assert.equal(loaded.manifest.schemaVersion, 1);
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

    const blocked = new NormalizedCacheStore(directory, { process: identity });
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
