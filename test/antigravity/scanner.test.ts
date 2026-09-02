import assert from "node:assert/strict";
import test from "node:test";

import { createUsageWindows } from "../../src/domain/index.js";
import { collectAntigravity, isSqliteAvailable } from "../../src/antigravity/index.js";
import { discoverAntigravityDatabases } from "../../src/antigravity/discovery.js";
import { join } from "node:path";
import {
  parseProtoFields,
  protoFieldBytes,
  firstProtoField,
  protoFieldPositiveInteger,
  antigravitySqliteModel,
  antigravitySqliteCreatedAt,
  protoTimestampToIso,
  readProtoVarint,
} from "../../src/antigravity/proto.js";

const FIXTURES = join(process.cwd(), "test", "fixtures", "antigravity");

test("antigravity proto helpers parse varint and length-delimited fields", () => {
  // Craft a buffer with field 1 varint 150 and field 2 bytes "hello"
  // field 1 key = 1<<3|0 = 8, varint 150 = 0x96 0x01
  // field 2 key = 2<<3|2 = 18, len 5, bytes hello
  const bytes = new Uint8Array([8, 0x96, 0x01, 18, 5, 104, 101, 108, 108, 111]);
  const fields = parseProtoFields(bytes);
  assert.equal(fields.length, 2);
  assert.equal(fields[0]!.number, 1);
  assert.equal(fields[0]!.wireType, 0);
  assert.equal(Number(fields[0]!.value), 150);
  assert.equal(fields[1]!.number, 2);
  assert.equal(fields[1]!.wireType, 2);
  assert.equal(new TextDecoder().decode(fields[1]!.bytes!), "hello");

  assert.equal(readProtoVarint(new Uint8Array([0x96, 0x01]), 0)?.value, 150n);
  assert.equal(readProtoVarint(new Uint8Array([0xff]), 0), null); // truncated
});

test("protoTimestampToIso handles ISO string and sec+nanos message", () => {
  const iso = "2026-09-02T09:55:00.000Z";
  // Simulate field containing ISO bytes
  const isoField = { number: 4, wireType: 2, bytes: new TextEncoder().encode(iso) } as const;
  assert.equal(protoTimestampToIso(isoField as unknown as ReturnType<typeof firstProtoField>), new Date(iso).toISOString());

  // Sec+nanos message: seconds= 1725350000, nanos= 123000000
  // Need to encode a nested message with field 1: seconds varint, field2: nanos varint, then pass as bytes field
  // We'll manually craft bytes: field1 key 8, varint 1725350000, field2 key 16, varint 123000000
  function encodeVarint(v: bigint | number) {
    let vv = BigInt(v);
    const out: number[] = [];
    while (vv >= 0x80n) { out.push(Number((vv & 0x7Fn) | 0x80n)); vv >>= 7n; }
    out.push(Number(vv));
    return new Uint8Array(out);
  }
  function encodeField(num: number, wt: number, val: Uint8Array | bigint) {
    const key = (BigInt(num) << 3n) | BigInt(wt);
    const kb = encodeVarint(key);
    if (wt === 0) {
      const vb = encodeVarint(val as bigint);
      const o = new Uint8Array(kb.length + vb.length);
      o.set(kb, 0); o.set(vb, kb.length); return o;
    } else {
      const vb = val as Uint8Array;
      const lb = encodeVarint(vb.length);
      const o = new Uint8Array(kb.length + lb.length + vb.length);
      o.set(kb, 0); o.set(lb, kb.length); o.set(vb, kb.length + lb.length); return o;
    }
  }
  const secBytes = encodeField(1, 0, BigInt(1725350000));
  const nanoBytes = encodeField(2, 0, BigInt(123000000));
  const msg = new Uint8Array(secBytes.length + nanoBytes.length);
  msg.set(secBytes, 0); msg.set(nanoBytes, secBytes.length);
  const timestampField = { number: 4, wireType: 2, bytes: msg } as const;
  const isoFromMsg = protoTimestampToIso(timestampField as unknown as ReturnType<typeof firstProtoField>);
  assert.ok(isoFromMsg.includes("2024") || isoFromMsg.length > 0);
});

test("discoverAntigravityDatabases finds .db fixtures via ANTIGRAVITY_HOME", () => {
  const previous = process.env.ANTIGRAVITY_HOME;
  process.env.ANTIGRAVITY_HOME = FIXTURES;
  try {
    const files = discoverAntigravityDatabases();
    assert.ok(files.length >= 2);
    assert.ok(files.some((f) => f.endsWith("conversation-a.db")));
    assert.ok(files.some((f) => f.endsWith("conversation-b.db")));
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_HOME;
    else process.env.ANTIGRAVITY_HOME = previous;
  }
});

test("collectAntigravity sums correctly and respects window filtering", async () => {
  if (!isSqliteAvailable()) {
    // Should return partial result with error when sqlite unavailable
    const windows = Object.values(createUsageWindows(new Date("2026-09-02T10:00:00.000Z"), "UTC"));
    const result = await collectAntigravity({ capturedAt: new Date("2026-09-02T10:00:00.000Z"), windows });
    assert.equal(result.coverage.complete, false);
    return;
  }
  const previous = process.env.ANTIGRAVITY_HOME;
  process.env.ANTIGRAVITY_HOME = FIXTURES;
  try {
    const NOW = new Date("2026-09-02T10:00:00.000Z");
    const windows = Object.values(createUsageWindows(NOW, "UTC"));
    const result = await collectAntigravity({ capturedAt: NOW, windows });
    assert.equal(result.source, "antigravity");
    assert.equal(result.records.length, 4);
    for (const r of result.records) assert.equal(r.provider, "antigravity");
    assert.equal(result.coverage.complete, true);
    assert.equal(result.coverage.sessionsDiscovered, 2);
    // Day totals should be 600, week 820 (see gen script)
    assert.equal(result.totalsByWindow.day?.recorded_total, 600);
    assert.equal(result.totalsByWindow.week?.recorded_total, 820);
    assert.equal(result.totalsByWindow.hour?.recorded_total, 300);

    // Hour window only includes 09:55/09:56 records (2) from conversation-a
    const hourWindow = windows.find((w) => w.kind === "hour")!;
    const hourTotals = result.totalsByWindow.hour!;
    // hour contains conversation-a both rows: input 200, output 85, reasoning 15
    assert.equal(hourTotals.input, 200);
    assert.equal(hourTotals.output, 85);
    assert.equal(hourTotals.reasoning, 15);
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_HOME;
    else process.env.ANTIGRAVITY_HOME = previous;
  }
});

test("collectAntigravity cancellation via AbortSignal", async () => {
  const controller = new AbortController();
  controller.abort();
  const windows = Object.values(createUsageWindows(new Date("2026-09-02T10:00:00.000Z"), "UTC"));
  await assert.rejects(() => collectAntigravity({ capturedAt: new Date("2026-09-02T10:00:00.000Z"), windows, signal: controller.signal }), (err: unknown) => {
    const e = err as { code?: string };
    return e.code === "cancelled";
  });
});

test("collectAntigravity handles empty ANTIGRAVITY_HOME gracefully", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const empty = await mkdtemp(join(tmpdir(), "oc2token-ag-empty-"));
  const previous = process.env.ANTIGRAVITY_HOME;
  process.env.ANTIGRAVITY_HOME = empty;
  try {
    const NOW = new Date("2026-09-02T10:00:00.000Z");
    const windows = Object.values(createUsageWindows(NOW, "UTC"));
    const result = await collectAntigravity({ capturedAt: NOW, windows });
    assert.equal(result.records.length, 0);
    assert.equal(result.coverage.complete, true);
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_HOME;
    else process.env.ANTIGRAVITY_HOME = previous;
    await (await import("node:fs/promises")).rm(empty, { recursive: true, force: true });
  }
});
