import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as zlib from "node:zlib";

import { createUsageWindows } from "../../src/domain/index.js";
import {
  collectDeepSeek,
  discoverDeepSeekSessionFiles,
  isZstdDecompressionAvailable,
  splitZstdFrames,
} from "../../src/deepseek/index.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");

function windows() {
  return Object.values(createUsageWindows(NOW, "UTC"));
}

function request() {
  return { capturedAt: NOW, windows: windows() };
}

function header(id: string, createdAt: number, isSeeded = false): unknown {
  return {
    type: "session",
    version: 4,
    id,
    createdAt,
    cwd: "/repo/ds",
    isSeeded,
    delegationDepth: 0,
  };
}

function event(type: string, seq: number, time: number, data: Record<string, unknown>): unknown {
  return { type, seq, time, data };
}

function usage(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  reasoningTokens = 0,
): Record<string, number> {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens };
}

async function withTempRoot(callback: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(join(tmpdir(), "oc2token-deepseek-"));
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeSession(
  root: string,
  sessionDir: string,
  file: string,
  entries: ReadonlyArray<unknown>,
): Promise<void> {
  const directory = join(root, "--repo-ds--", sessionDir);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(join(directory, file), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

function sessionEntries(id: string, createdAt: number): ReadonlyArray<unknown> {
  return [
    header(id, createdAt),
    event("request/header", 1, createdAt + 1, {
      header: { config: { provider: "deepseek", model: "deepseek-v4-pro" } },
      reason: "initial",
    }),
    event("assistant/message", 10, Date.parse("2026-09-02T11:10:00.000Z"), {
      message: {
        role: "assistant",
        id: "msg-1",
        content: [],
        source: { kind: "model", provider: "deepseek", model: "deepseek-v4-pro" },
      },
      stream: [],
      usage: usage(100, 40, 10, 5, 10),
    }),
    event("compaction/summary", 11, Date.parse("2026-09-02T11:20:00.000Z"), {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      summary: [],
      usage: usage(20, 6, 0, 0, 1),
    }),
    event("assistant/attempt", 12, Date.parse("2026-09-02T11:30:00.000Z"), {
      stream: [
        {
          type: "chunk",
          time: Date.parse("2026-09-02T11:30:00.000Z"),
          chunk: { type: "usage", usage: usage(7, 3, 0, 0, 1) },
        },
      ],
    }),
    event("assistant/message", 13, Date.parse("2026-09-01T09:00:00.000Z"), {
      message: {
        role: "assistant",
        id: "msg-2",
        content: [],
        source: { kind: "model", provider: "deepseek", model: "deepseek-v4-pro" },
      },
      stream: [],
      usage: usage(1000, 100),
    }),
  ];
}

test("discoverDeepSeekSessionFiles selects the newest generation per session", async () => {
  await withTempRoot(async (root) => {
    await writeSession(root, "session-ds1", "session.v3.jsonl", [header("old", Date.now())]);
    await writeSession(root, "session-ds1", "session.v4.jsonl", [header("new", Date.now())]);
    const files = discoverDeepSeekSessionFiles(root);
    assert.equal(files.length, 1);
    assert.ok(files[0]!.path.endsWith("session.v4.jsonl"));
    assert.equal(files[0]!.version, 4);
  });
});

test("collectDeepSeek maps disjoint usage buckets and failed-attempt usage", async () => {
  await withTempRoot(async (root) => {
    await writeSession(
      root,
      "session-ds1",
      "session.v4.jsonl",
      sessionEntries("session-ds1", Date.parse("2026-09-02T08:00:00.000Z")),
    );
    // A stale generation must never contribute usage.
    await writeSession(root, "session-ds1", "session.v3.jsonl", [
      header("session-ds1", Date.parse("2026-09-02T08:00:00.000Z")),
      event("assistant/message", 2, Date.parse("2026-09-02T11:00:00.000Z"), {
        message: { role: "assistant", content: [], source: { provider: "deepseek", model: "stale" } },
        stream: [],
        usage: usage(999_999, 0),
      }),
    ]);

    const result = await collectDeepSeek(request(), root);
    assert.equal(result.source, "deepseek");
    assert.equal(result.coverage.complete, true);
    assert.equal(result.coverage.sessionsDiscovered, 1);
    assert.equal(result.coverage.sessionsScanned, 1);
    assert.equal(result.records.length, 4);
    for (const record of result.records) assert.equal(record.provider, "deepseek");

    const hour = result.totalsByWindow.hour!;
    assert.equal(hour.input, 127);
    assert.equal(hour.output, 37);
    assert.equal(hour.reasoning, 12);
    assert.equal(hour.cacheRead, 10);
    assert.equal(hour.cacheWrite, 5);
    assert.equal(hour.recorded_total, 191);

    const day = result.totalsByWindow.day!;
    assert.equal(day.recorded_total, 191);

    const week = result.totalsByWindow.week!;
    assert.equal(week.input, 1127);
    assert.equal(week.recorded_total, 1291);

    assert.deepEqual(
      result.providersByWindow?.hour?.map((item) => item.name),
      ["deepseek"],
    );
    assert.deepEqual(
      result.modelsByWindow?.hour?.map((item) => item.name),
      ["deepseek/deepseek-v4-pro"],
    );
    assert.deepEqual(
      result.projectsByWindow?.hour?.map((item) => item.name),
      ["/repo/ds"],
    );
  });
});

test("collectDeepSeek skips the inherited prefix of seeded sessions", async () => {
  await withTempRoot(async (root) => {
    await writeSession(root, "session-ds2", "session.v4.jsonl", [
      header("session-ds2", Date.parse("2026-09-02T11:00:00.000Z"), true),
      event("assistant/message", 2, Date.parse("2026-09-02T11:05:00.000Z"), {
        message: { role: "assistant", content: [], source: { provider: "deepseek", model: "deepseek-v4-pro" } },
        stream: [],
        usage: usage(999, 0),
      }),
      event("session/end-seed", 1, Date.parse("2026-09-02T11:00:00.000Z"), { inherited: true }),
      event("assistant/message", 3, Date.parse("2026-09-02T11:40:00.000Z"), {
        message: { role: "assistant", content: [], source: { provider: "deepseek", model: "deepseek-v4-pro" } },
        stream: [],
        usage: usage(7, 0),
      }),
    ]);

    const result = await collectDeepSeek(request(), root);
    assert.equal(result.records.length, 1);
    assert.equal(result.totalsByWindow.hour?.input, 7);
  });
});

test("collectDeepSeek reads concatenated zstd frames", { skip: !isZstdDecompressionAvailable() }, async () => {
  const compress = (zlib as unknown as { zstdCompressSync?: (buffer: Buffer) => Buffer }).zstdCompressSync;
  assert.ok(compress !== undefined);

  await withTempRoot(async (root) => {
    const entries = sessionEntries("session-ds-zstd", Date.parse("2026-09-02T08:00:00.000Z"));
    const lines = entries.map((entry) => JSON.stringify(entry) + "\n");
    // dsh writes the header alone in one frame and each append batch in its own.
    const frames = [compress!(Buffer.from(lines[0]!, "utf8")), compress!(Buffer.from(lines.slice(1).join(""), "utf8"))];
    const buffer = Buffer.concat(frames);
    assert.equal(splitZstdFrames(buffer).length, 2);

    const directory = join(root, "--repo-ds--", "session-ds-zstd");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(join(directory, "session.v4.jsonl.zstd"), buffer);

    const result = await collectDeepSeek(request(), root);
    assert.equal(result.coverage.complete, true);
    assert.equal(result.totalsByWindow.hour?.recorded_total, 191);
    assert.equal(result.totalsByWindow.week?.recorded_total, 1291);
  });
});

test("collectDeepSeek cancellation via AbortSignal is propagated", async () => {
  await withTempRoot(async (root) => {
    await writeSession(root, "session-cancel", "session.v4.jsonl", [header("session-cancel", Date.now())]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => collectDeepSeek({ ...request(), signal: controller.signal }, root),
      (error: unknown) => (error as { code?: string }).code === "cancelled",
    );
  });
});
