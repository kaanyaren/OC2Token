import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTokenComponents,
  recorded_total,
  toUsageTotals,
  validateTokenComponents,
} from "../../src/domain/index.js";

const expected = {
  input: 10,
  output: 20,
  reasoning: 3,
  cacheRead: 4,
  cacheWrite: 5,
};

test("normalizes OpenCode token fields and computes recorded_total", () => {
  const components = parseTokenComponents({
    input: 10,
    output: 20,
    reasoning: 3,
    cache: { read: 4, write: 5 },
  });

  assert.deepEqual(components, expected);
  assert.equal(recorded_total(components), 42);
  assert.deepEqual(toUsageTotals(components), { ...expected, recorded_total: 42 });
});

test("omitted fields in a present token object are zero", () => {
  assert.deepEqual(parseTokenComponents({ input: 7, output: 0 }), {
    input: 7,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(validateTokenComponents({ cache: { read: 2 } }).ok, true);
  assert.equal(validateTokenComponents(undefined).ok, false);
});

test("rejects absent, negative, fractional, non-finite, and conflicting values", () => {
  for (const value of [
    undefined,
    null,
    { input: -1 },
    { output: 1.5 },
    { reasoning: Number.POSITIVE_INFINITY },
    { cache: { write: Number.NaN } },
    { cacheRead: 1, cache: { read: 2 } },
  ]) {
    const result = validateTokenComponents(value);
    assert.equal(result.ok, false);
  }

  assert.throws(
    () => parseTokenComponents(undefined),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "missing-token-components",
  );
});

test("recorded_total refuses arithmetic outside the safe integer range", () => {
  assert.throws(
    () =>
      recorded_total({
        input: Number.MAX_SAFE_INTEGER,
        output: 1,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "invalid-token-components",
  );
});
