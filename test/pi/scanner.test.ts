import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createUsageWindows } from "../../src/domain/index.js";
import { collectPi, discoverPiSessionFiles } from "../../src/pi/index.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");

function windows() {
  return Object.values(createUsageWindows(NOW, "UTC"));
}

function request() {
  return { capturedAt: NOW, windows: windows() };
}

function header(id: string, timestamp: string, parentSession?: string): unknown {
  return {
    type: "session",
    version: 3,
    id,
    timestamp,
    cwd: "/repo/pi",
    ...(parentSession === undefined ? {} : { parentSession }),
  };
}

function assistant(
  id: string,
  timestamp: string,
  usage: Record<string, number>,
  model = "deepseek-v4.1-flash",
): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: {
      role: "assistant",
      provider: "opencode-go",
      model,
      usage,
      stopReason: "stop",
      timestamp: Date.parse(timestamp),
    },
  };
}

async function withTempRoot(callback: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(join(tmpdir(), "oc2token-pi-"));
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeSession(root: string, file: string, entries: ReadonlyArray<unknown>): Promise<void> {
  const project = join(root, "--repo-pi--");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(join(project, file), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

test("discoverPiSessionFiles walks project directories and ignores symlinks", async () => {
  await withTempRoot(async (root) => {
    await writeSession(root, "2026-09-02T11-00-00-000Z_pi-a.jsonl", [header("pi-a", "2026-09-02T11:00:00.000Z")]);
    const files = discoverPiSessionFiles(root);
    assert.equal(files.length, 1);
    assert.ok(files[0]!.endsWith("pi-a.jsonl"));
  });
});

test("collectPi maps usage buckets without double-counting reasoning and filters windows", async () => {
  await withTempRoot(async (root) => {
    await writeSession(root, "2026-09-02T08-00-00-000Z_pi-session-1.jsonl", [
      header("pi-session-1", "2026-09-02T08:00:00.000Z"),
      {
        type: "model_change",
        id: "m1",
        parentId: null,
        timestamp: "2026-09-02T08:00:01.000Z",
        provider: "opencode-go",
        modelId: "deepseek-v4.1-flash",
      },
      {
        type: "message",
        id: "u1",
        parentId: "m1",
        timestamp: "2026-09-02T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
      // hour + day: reasoning is a subset of output, so it must be split out.
      assistant("a1", "2026-09-02T11:30:00.000Z", {
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
        reasoning: 20,
        totalTokens: 165,
      }),
      // Nested model work in a tool result.
      {
        type: "message",
        id: "t1",
        parentId: "a1",
        timestamp: "2026-09-02T11:45:00.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "subagent",
          content: [],
          usage: {
            input: 30,
            output: 12,
            cacheRead: 4,
            cacheWrite: 0,
            reasoning: 2,
            totalTokens: 46,
          },
        },
      },
      // Cache warming / non-message model work.
      {
        type: "usage",
        id: "w1",
        parentId: "t1",
        timestamp: "2026-09-02T10:10:00.000Z",
        kind: "cache_warm",
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        usage: { input: 200, output: 80, cacheRead: 20, cacheWrite: 0, reasoning: 10 },
      },
      // Previous local day: week only.
      assistant("a2", "2026-09-01T09:00:00.000Z", {
        input: 1000,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
      }),
    ]);

    const result = await collectPi(request(), root);
    assert.equal(result.source, "pi");
    assert.equal(result.coverage.complete, true);
    assert.equal(result.coverage.sessionsDiscovered, 1);
    assert.equal(result.coverage.sessionsScanned, 1);
    assert.equal(result.records.length, 4);
    for (const record of result.records) assert.equal(record.provider, "pi");

    const hour = result.totalsByWindow.hour!;
    assert.equal(hour.input, 130);
    assert.equal(hour.output, 40);
    assert.equal(hour.reasoning, 22);
    assert.equal(hour.cacheRead, 14);
    assert.equal(hour.cacheWrite, 5);
    assert.equal(hour.recorded_total, 211);

    const day = result.totalsByWindow.day!;
    assert.equal(day.input, 330);
    assert.equal(day.output, 110);
    assert.equal(day.reasoning, 32);
    assert.equal(day.cacheRead, 34);
    assert.equal(day.cacheWrite, 5);
    assert.equal(day.recorded_total, 511);

    const week = result.totalsByWindow.week!;
    assert.equal(week.input, 1330);
    assert.equal(week.recorded_total, 1611);
    assert.deepEqual(
      result.providersByWindow?.hour?.map((item) => item.name),
      ["pi"],
    );
    assert.deepEqual(
      result.projectsByWindow?.day?.map((item) => item.name),
      ["/repo/pi"],
    );
    assert.deepEqual(
      result.modelsByWindow?.day?.map((item) => item.name),
      ["opencode-go/deepseek-v4.1-flash"],
    );
  });
});

test("collectPi skips inherited entries in forked sessions", async () => {
  await withTempRoot(async (root) => {
    await writeSession(root, "2026-09-02T11-00-00-000Z_pi-parent.jsonl", [
      header("pi-parent", "2026-09-02T11:00:00.000Z"),
      assistant("p1", "2026-09-02T11:10:00.000Z", {
        input: 111,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
      }),
    ]);
    await writeSession(root, "2026-09-02T11-40-00-000Z_pi-child.jsonl", [
      header("pi-child", "2026-09-02T11:40:00.000Z", "/repo/pi/pi-parent.jsonl"),
      // Copied from the parent with its original timestamp: not new work.
      assistant("p1", "2026-09-02T11:10:00.000Z", {
        input: 999,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
      }),
      assistant("c1", "2026-09-02T11:50:00.000Z", {
        input: 7,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
      }),
      {
        type: "usage",
        id: "c2",
        parentId: "c1",
        timestamp: "2026-09-02T11:55:00.000Z",
        kind: "cache_warm",
        usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      },
    ]);

    const result = await collectPi(request(), root);
    assert.equal(result.records.length, 3);
    assert.equal(result.totalsByWindow.hour?.input, 121);
  });
});

test("collectPi cancellation via AbortSignal is propagated", async () => {
  await withTempRoot(async (root) => {
    await writeSession(root, "2026-09-02T11-00-00-000Z_pi-cancel.jsonl", [
      header("pi-cancel", "2026-09-02T11:00:00.000Z"),
    ]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => collectPi({ ...request(), signal: controller.signal }, root),
      (error: unknown) => (error as { code?: string }).code === "cancelled",
    );
  });
});
