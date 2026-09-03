import assert from "node:assert/strict";
import test from "node:test";

import type { UsageTotals } from "../../src/domain/tokens.js";
import {
  PRICING_AS_OF,
  PRICING_VERSION,
  costForTokens,
  estimateCostForBreakdownsDetailed,
  estimatedCostForBreakdowns,
  pricingForModel,
  resolvePricing,
} from "../../src/pricing/pricing.js";

function totals(overrides: Partial<UsageTotals> = {}): UsageTotals {
  const base = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    recorded_total:
      overrides.recorded_total ??
      merged.input + merged.output + merged.reasoning + merged.cacheRead + merged.cacheWrite,
  };
}

test("pricing table carries a version and as-of date", () => {
  assert.equal(typeof PRICING_VERSION, "number");
  assert.match(PRICING_AS_OF, /^\d{4}-\d{2}-\d{2}$/);
});

test("exact map hit is not estimated", () => {
  const pricing = pricingForModel("gpt-5-mini");
  assert.ok(pricing !== undefined);
  assert.equal(pricing.input, 0.25);
  assert.equal(pricing.output, 2);

  const resolution = resolvePricing("gpt-5-mini");
  assert.equal(resolution.estimated, false);
  assert.equal(resolution.pricing, pricing);

  // Provider-prefixed exact hit is also exact.
  assert.equal(resolvePricing("openai/gpt-5-mini").estimated, false);

  // Cost math: 1M input tokens at $0.25/1M + 1M output at $2/1M = $2.25.
  const cost = costForTokens(totals({ input: 1_000_000, output: 1_000_000 }), pricing);
  assert.equal(cost, 2.25);
});

test("unknown model resolves to undefined", () => {
  assert.equal(pricingForModel("definitely-not-a-model-xyz"), undefined);
  const resolution = resolvePricing("definitely-not-a-model-xyz");
  assert.equal(resolution.pricing, undefined);
  assert.equal(pricingForModel(""), undefined);
});

test("fuzzy fallback is marked estimated", () => {
  // Not in the exact table, but clearly a GPT-5 mini variant.
  const resolution = resolvePricing("gpt-5-mini-preview");
  assert.ok(resolution.pricing !== undefined);
  assert.equal(resolution.estimated, true);
  assert.equal(resolution.pricing.input, 0.25);
});

test("short o-series tokens no longer over-match", () => {
  // "foo1" contains the substring "o1" but is not OpenAI o1.
  assert.equal(pricingForModel("my-foo1-model"), undefined);
  // Real o1 variants still resolve (exact or fuzzy).
  assert.ok(pricingForModel("o1") !== undefined);
  assert.ok(pricingForModel("o1-mini") !== undefined);
});

test("strict mode returns a partial cost instead of poisoning the window", () => {
  const known = totals({ input: 1_000_000 });
  const breakdowns = [
    { name: "gpt-5-mini", totals: known },
    { name: "definitely-not-a-model-xyz", totals: totals({ input: 1_000_000 }) },
  ];
  const expectedPartial = costForTokens(known, pricingForModel("gpt-5-mini")!);

  // Old behavior returned undefined here; now the known portion is kept.
  assert.equal(estimatedCostForBreakdowns(breakdowns, true), expectedPartial);
  assert.equal(estimatedCostForBreakdowns(breakdowns, false), expectedPartial);

  const detailed = estimateCostForBreakdownsDetailed(breakdowns);
  assert.equal(detailed.cost, expectedPartial);
  assert.equal(detailed.complete, false);
  assert.deepEqual(detailed.unknownModels, ["definitely-not-a-model-xyz"]);
});

test("all-unknown breakdowns stay undefined; all-exact is complete", () => {
  const unknown = [{ name: "nope-1", totals: totals({ input: 5 }) }];
  assert.equal(estimatedCostForBreakdowns(unknown, true), undefined);
  assert.equal(estimateCostForBreakdownsDetailed(unknown).complete, false);

  const exact = [{ name: "gpt-5-mini", totals: totals({ input: 5 }) }];
  const detailed = estimateCostForBreakdownsDetailed(exact);
  assert.equal(detailed.complete, true);
  assert.deepEqual(detailed.unknownModels, []);
  assert.deepEqual(detailed.estimatedModels, []);
  assert.equal(estimatedCostForBreakdowns(exact, true), detailed.cost);
});
