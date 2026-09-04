import assert from "node:assert/strict";
import test from "node:test";
import {
  createUsageRecord,
  createUsageWindows,
  toUsageTotals,
} from "../../src/domain/index.js";
import {
  ANSI,
  formatTokenCount,
  renderDashboard,
  renderInPlace,
  renderOutput,
  themeOrange,
  themePurple,
  toJSONSnapshot,
  usageTotalsFrom,
} from "../../src/output/index.js";

const NOW = new Date("2026-09-02T10:00:00.000Z");

function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const windows = Object.values(createUsageWindows(NOW, "Europe/Istanbul"));
  const record = createUsageRecord({
    sessionID: "session-1",
    messageID: "message-1",
    createdAt: new Date("2026-09-02T09:55:00.000Z"),
    model: "openai/gpt-5",
    tokens: { input: 100, output: 20, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
    observedAt: NOW,
    completeness: "final",
  });
  const totals = toUsageTotals({ input: 100, output: 20, reasoning: 3, cacheRead: 4, cacheWrite: 5 });
  return {
    capturedAt: NOW,
    windows,
    source: "message-scan",
    serverVersion: "beta-18866",
    records: [record],
    totalsByWindow: { hour: totals, day: totals, week: totals },
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
    nextRefreshAt: new Date("2026-09-02T10:05:00.000Z"),
    ...overrides,
  };
}

function recordFor(model: string, createdAt: Date, input: number) {
  const id = model.replaceAll("/", "-");
  return createUsageRecord({
    sessionID: `${id}-session`,
    messageID: `${id}-message`,
    createdAt,
    model,
    tokens: { input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    observedAt: NOW,
    completeness: "final",
  });
}

test("formatting recomputes recorded_total from all five components", () => {
  assert.deepEqual(
    usageTotalsFrom({ input: 100, output: 20, reasoning: 3, cache: { read: 4, write: 5 }, recorded_total: 999 }),
    { input: 100, output: 20, reasoning: 3, cacheRead: 4, cacheWrite: 5, recorded_total: 132 },
  );
  assert.equal(formatTokenCount(1_234), "1.2K");
});

test("JSON emits exact windows and stable metadata", () => {
  const json = toJSONSnapshot(fixture());
  assert.deepEqual(Object.keys(json), [
    "schemaVersion", "windows", "source", "version", "lastUpdated",
    "nextRefreshAt", "stale", "coverage", "totals", "costs", "trends", "models", "providers",
    "projects", "providersByWindow", "projectsByWindow", "totalsByProvider", "totalsByProject",
    "costsByProvider", "costsByProject",
  ]);
  assert.equal(json.windows.day.from, "2026-09-01T21:00:00.000Z");
  assert.equal(json.windows.week.to, "2026-09-06T21:00:00.000Z");
  assert.equal(json.source, "message-scan");
  assert.equal(json.version, "beta-18866");
  assert.equal(json.lastUpdated, "2026-09-02T10:00:00.000Z");
  assert.equal(json.nextRefreshAt, "2026-09-02T10:05:00.000Z");
  assert.equal(json.totals.day.recorded_total, 132);
  assert.equal(json.models[0]?.name, "openai/gpt-5");
  assert.equal(json.providers[0]?.name, "opencode");
});

test("partial and stale snapshots remain visibly honest", () => {
 const output = renderDashboard(fixture({
   stale: true,
    coverage: { complete: false, sessionsDiscovered: 1, sessionsScanned: 1, sessionsSkipped: 0, pagesRead: 1, jobsRetried: 0, provisionalMessages: 0, errors: [{ code: "transport", retryable: true }] },
  }), { isTTY: true, color: false, width: 100, now: NOW });
  assert.match(output, /Status: STALE/);
  assert.match(output, /1 error/);
  const json = toJSONSnapshot(fixture({ stale: true }));
  assert.equal(json.stale, true);
  assert.equal(json.coverage.complete, false);
});

test("interactive header keeps the top bar focused on the app identity", () => {
  const output = renderDashboard(fixture(), { isTTY: true, color: false, width: 100, now: NOW });
  const topBar = output.slice(0, output.indexOf("◆ Trend"));
  assert.match(topBar, /OC2TOKEN|OpenCode 2 Token Usage/);
  assert.doesNotMatch(topBar, /Source:|Version:|Window:|Timezone:|Status:/);
  assert.match(output, /Status: COMPLETE/);
});

test("narrow dashboard uses one column and contains the navigation footer", () => {
  const output = renderDashboard(fixture(), { isTTY: true, color: false, width: 60, now: NOW });
  const cardRows = output.split("\n").filter((line) => line.startsWith("╭"));
  assert.equal(cardRows.length, 3);
  assert.ok(cardRows.every((line) => !line.includes("╮  ╭")));
  assert.match(output, /r Refresh/);
  assert.doesNotMatch(output, /\u001b\[/);
});

test("very narrow dashboard truncates every line instead of relying on wrapping", () => {
  for (const width of [20, 40]) {
    const output = renderDashboard(fixture(), { isTTY: true, color: false, width, now: NOW });
    assert.ok(output.split("\n").every((line) => [...line].length <= width));
  }
});

test("piped auto output is plain table and redraw is in-place ANSI only", () => {
  const piped = renderOutput(fixture(), { isTTY: false });
  assert.match(piped, /Window.*Recorded/);
  assert.doesNotMatch(piped, /\u001b\[/);
  const frame = renderInPlace("one\ntwo", 3, { isTTY: true, ansi: true, color: false });
  assert.ok(frame.startsWith(ANSI.cursorHome));
  assert.ok(frame.includes(ANSI.clearLine));
  assert.doesNotMatch(frame, /\u001b\[2J/);
});

test("safe labels cannot inject terminal controls or line breaks", () => {
  const evil = createUsageRecord({
    sessionID: "evil-session",
    messageID: "evil-message",
    createdAt: new Date("2026-09-02T09:55:00.000Z"),
    model: "prompt\n\u001b[31msecret",
    tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    observedAt: NOW,
    completeness: "final",
  });
  const output = renderDashboard(fixture({ records: [evil] }), { isTTY: true, color: false, width: 100 });
  assert.doesNotMatch(output, /\u001b\[/);
  assert.doesNotMatch(output, /prompt\n/);
  assert.match(output, /prompt_secret/);
});

test("colored dashboard keeps semantic status colors behind the ANSI option", () => {
  const previousNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  let output: string;
  try {
    output = renderDashboard(fixture(), {
      isTTY: true,
      ansi: true,
      color: true,
      width: 100,
      now: NOW,
    });
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }

  assert.ok(output.includes(ANSI.green));
  assert.ok(output.includes(ANSI.purple));
  assert.ok(output.includes(ANSI.orange));
  assert.ok(output.includes(ANSI.orangeBright));
  assert.ok(output.includes(ANSI.reset));
  assert.ok(output.includes(ANSI.purpleBright));
  assert.match(output, /TOKEN USAGE|Models|Providers/);
});

test("purple/orange theme helpers are ANSI-gated and support bright accents", () => {
  assert.equal(themePurple("header", false), "header");
  assert.equal(themeOrange("focus", false), "focus");
  assert.equal(themePurple("header", true), `${ANSI.purple}header${ANSI.reset}`);
  assert.equal(themePurple("accent", true, true), `${ANSI.purpleBright}accent${ANSI.reset}`);
  assert.equal(themeOrange("focus", true), `${ANSI.orange}focus${ANSI.reset}`);
  assert.equal(themeOrange("accent", true, true), `${ANSI.orangeBright}accent${ANSI.reset}`);
});

test("theme updates cannot make plain or machine-readable output depend on ANSI", () => {
  const plain = renderDashboard(fixture(), { isTTY: true, color: false, width: 100, now: NOW });
  const piped = renderOutput(fixture(), { isTTY: false });
  const json = toJSONSnapshot(fixture());

  assert.doesNotMatch(plain, /\u001b\[/);
  assert.doesNotMatch(piped, /\u001b\[/);
  assert.equal(typeof json.totals.day.recorded_total, "number");
  assert.equal(json.models[0]?.name, "openai/gpt-5");
});

test("trend panel renders a graph rather than one textual row per bucket", () => {
  const trends = Array.from({ length: 8 }, (_, index) => ({
    label: `bucket-${index}`,
    totals: toUsageTotals({
      input: (index + 1) * 10,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  }));
  const output = renderDashboard(fixture({ trends: { day: trends } }), {
    isTTY: true,
    color: false,
    width: 100,
    selectedWindow: "day",
    now: NOW,
  });
  const trendStart = output.indexOf("Trend · today");
  const trendEnd = output.indexOf("◆ Models", trendStart);
  assert.ok(trendStart >= 0 && trendEnd > trendStart);
  const trendPanel = output.slice(trendStart, trendEnd);
  assert.match(trendPanel, /[▇█▉▊▋]/, "trend should contain plotted graph cells");
  assert.ok(
    trendPanel.split("\n").filter((line) => line.trim().length > 0).length < trends.length + 2,
    "graph must not render one full text row for every bucket",
  );
  assert.doesNotMatch(trendPanel, /bucket-0/);
});

test("stats snapshots use persisted trend buckets when records are empty", () => {
  const output = renderDashboard(fixture({
    source: "stats",
    records: [],
    trendsByWindow: {
      day: Array.from({ length: 24 }, (_, index) => ({
        label: `${String(index).padStart(2, "0")}:00`,
        from: new Date(NOW.getTime() - (24 - index) * 60 * 60 * 1_000),
        to: new Date(NOW.getTime() - (23 - index) * 60 * 60 * 1_000),
        totals: toUsageTotals({
          input: index === 12 ? 250 : 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        }),
      })),
    },
  }), {
    isTTY: true,
    color: false,
    width: 100,
    selectedWindow: "day",
    now: NOW,
  });
  const trendStart = output.indexOf("Trend · today");
  const trendEnd = output.indexOf("◆ Models", trendStart);
  const trendPanel = output.slice(trendStart, trendEnd);
  assert.ok(trendStart >= 0 && trendEnd > trendStart);
  assert.match(trendPanel, /[▇█▉▊▋]/, "stats trend should contain plotted graph cells");
  assert.doesNotMatch(trendPanel, /No trend data recorded/);
});

test("models and providers use the selected window breakdown values", () => {
  const output = renderDashboard(fixture({
    modelsByWindow: {
      hour: [{ name: "openai/gpt-5", totals: toUsageTotals({ input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }) }],
      day: [{ name: "openai/gpt-5", totals: toUsageTotals({ input: 222, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }) }],
    },
    providersByWindow: {
      hour: [{ name: "openai", totals: toUsageTotals({ input: 2, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }) }],
      day: [{ name: "openai", totals: toUsageTotals({ input: 333, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }) }],
    },
  }), { isTTY: true, color: false, width: 100, selectedWindow: "day", now: NOW });
  const modelsStart = output.indexOf("◆ Models");
  const providersStart = output.indexOf("◆ Providers", modelsStart);
  const breakdown = output.slice(modelsStart);
  const models = output.slice(modelsStart, providersStart);
  const providers = breakdown.slice(providersStart - modelsStart);
  assert.match(models, /openai\/gpt-5\s+222/);
  assert.match(providers, /openai\s+333/);
  assert.doesNotMatch(models, /openai\/gpt-5\s+1\b/);
  assert.doesNotMatch(providers, /openai\s+2\b/);
});

test("message-scan model and provider breakdowns follow each window boundary", () => {
  const records = [
    recordFor("hour/model", new Date(NOW.getTime() - 30 * 60 * 1_000), 11),
    recordFor("day/model", new Date(NOW.getTime() - 3 * 60 * 60 * 1_000), 22),
    recordFor("week/model", new Date(NOW.getTime() - 24 * 60 * 60 * 1_000), 33),
  ];

  const expectedProviderTotals: Record<string, string> = {
    hour: "11",
    day: "33",
    week: "66",
  };
  for (const [selectedWindow, expectedModels, excludedModels] of [
    ["hour", ["hour/model"], ["day/model", "week/model"]],
    ["day", ["hour/model", "day/model"], ["week/model"]],
    ["week", ["hour/model", "day/model", "week/model"], []],
  ] as const) {
    const output = renderDashboard(fixture({ records }), {
      isTTY: true,
      color: false,
      width: 100,
      selectedWindow,
      now: NOW,
    });
    const modelsStart = output.indexOf("◆ Models");
    const providersStart = output.indexOf("◆ Providers", modelsStart);
    const models = output.slice(modelsStart, providersStart);
    for (const [model, total] of expectedModels.map((model) => [model, model.startsWith("hour") ? "11" : model.startsWith("day") ? "22" : "33"] as const)) {
      assert.match(models, new RegExp(`${model}\\s+${total}`));
    }
    for (const otherModel of excludedModels) {
      assert.doesNotMatch(models, new RegExp(otherModel.replace("/", "\\/")), `unexpected model in ${selectedWindow}`);
    }
    // Providers use raw provider names (opencode/codex/antigravity) to match
    // Unified totalsByProvider keys; vendor lives in Models breakdown.
    assert.match(output.slice(providersStart), new RegExp(`\\bopencode\\s+${expectedProviderTotals[selectedWindow]}`));
  }
});

test("trend graph remains ANSI-free with no-color and colored when enabled", () => {
  const input = fixture({ trends: { day: [{ label: "09:00", totals: toUsageTotals({ input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }) }] } });
  const plain = renderDashboard(input, { isTTY: true, color: false, width: 100, selectedWindow: "day" });
  const previousNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  let colored: string;
  try {
    colored = renderDashboard(input, { isTTY: true, ansi: true, color: true, width: 100, selectedWindow: "day" });
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
  assert.doesNotMatch(plain, /\u001b\[/);
  assert.match(colored, /\u001b\[/);
  assert.match(plain, /Trend · today/);
});

test("JSON snapshot uses schemaVersion 4 and exposes totalsByProvider per window", () => {
  const json = toJSONSnapshot(fixture());
  assert.equal(json.schemaVersion, 4);
  assert.ok(json.totalsByProvider);
  for (const kind of ["hour", "day", "week"] as const) {
    assert.ok(kind in json.totalsByProvider);
    assert.ok(kind in json.providersByWindow);
  }
  // Single-provider fixture: totalsByProvider matches providers list
  assert.ok(Object.keys(json.totalsByProvider.day).includes("opencode"));
  assert.equal(json.totalsByProvider.day["opencode"]?.recorded_total, 132);
  assert.equal(json.providers.length, 1);
  assert.equal(json.providersByWindow.day.length, 1);
});

test("unified multi-provider JSON and dashboard render without loss", () => {
  const windows = Object.values(createUsageWindows(NOW, "UTC"));
  function rec(provider: string, model: string, input: number, createdAt: Date) {
    return createUsageRecord({
      sessionID: `${provider}-session`,
      messageID: `${provider}-msg-${input}-${createdAt.getTime()}`,
      createdAt,
      model,
      tokens: { input, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      observedAt: NOW,
      completeness: "final",
      provider: provider as "opencode" | "codex" | "antigravity",
    });
  }
  const records = [
    rec("opencode", "openai/gpt-5", 100, new Date("2026-09-02T09:55:00.000Z")),
    rec("codex", "codex-model", 50, new Date("2026-09-02T09:56:00.000Z")),
    rec("antigravity", "gemini-3-pro", 30, new Date("2026-09-02T09:57:00.000Z")),
  ];
  const totals = toUsageTotals({ input: 180, output: 15, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  const input: Record<string, unknown> = {
    capturedAt: NOW,
    windows,
    source: "unified",
    records,
    totalsByWindow: { hour: totals, day: totals, week: totals },
    coverage: { complete: true, sessionsDiscovered: 3, sessionsScanned: 3, sessionsSkipped: 0, pagesRead: 3, jobsRetried: 0, provisionalMessages: 0, errors: [] },
  };
  const json = toJSONSnapshot(input);
  assert.equal(json.schemaVersion, 4);
  assert.equal(json.source, "unified");
  // All three providers appear in aggregated providers list (raw opencode/codex/antigravity to match Unified keys)
  const names = json.providers.map((p) => p.name).sort();
  assert.ok(names.includes("opencode"));
  assert.ok(names.includes("codex"));
  assert.ok(names.includes("antigravity"));
  assert.ok(json.totalsByProvider.hour["codex"]);
  assert.ok(json.totalsByProvider.hour["antigravity"]);
  assert.equal(json.totalsByProvider.hour["codex"]?.input, 50);
  assert.equal(json.totalsByProvider.hour["antigravity"]?.input, 30);
  assert.ok(json.costs);
  assert.ok(json.costsByProvider);
  assert.ok(json.costsByProject);
  for (const kind of ["hour", "day", "week"] as const) {
    assert.ok(kind in json.costs);
    assert.ok(kind in json.costsByProvider);
    assert.ok(kind in json.costsByProject);
  }
  assert.ok(typeof json.costs.hour === "number" || json.costs.hour === null);
  assert.ok(json.costsByProvider.hour["codex"] !== undefined);
  assert.ok(json.costsByProvider.hour["antigravity"] !== undefined);

  const dash = renderDashboard(input, { isTTY: true, color: false, width: 100, now: NOW, selectedWindow: "day" });
  assert.match(dash, /Providers/);
  assert.match(dash, /opencode/);
  assert.match(dash, /codex/);
  assert.match(dash, /antigravity/);
  // Provider stack line should contain percentages
  assert.match(dash, /\(\d+%\)/);
  // Table rendering also contains unified source
  const table = renderOutput(input, { format: "table", isTTY: false });
  assert.match(table, /Source: unified/);
});

test("provider stack stacks vertically under narrow width", () => {
  const windows = Object.values(createUsageWindows(NOW, "UTC"));
  const records = [
    createUsageRecord({ sessionID: "a", messageID: "m1", createdAt: new Date("2026-09-02T09:55:00.000Z"), model: "m/a", tokens: { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, observedAt: NOW, completeness: "final", provider: "codex" }),
    createUsageRecord({ sessionID: "b", messageID: "m2", createdAt: new Date("2026-09-02T09:55:00.000Z"), model: "m/b", tokens: { input: 20, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, observedAt: NOW, completeness: "final", provider: "antigravity" }),
  ];
  const totals = toUsageTotals({ input: 30, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  const snap: Record<string, unknown> = {
    capturedAt: NOW,
    windows,
    source: "unified",
    records,
    totalsByWindow: { hour: totals, day: totals, week: totals },
    coverage: { complete: true, sessionsDiscovered: 2, sessionsScanned: 2, sessionsSkipped: 0, pagesRead: 2, jobsRetried: 0, provisionalMessages: 0, errors: [] },
  };
  const narrow = renderDashboard(snap, { isTTY: true, color: false, width: 60, now: NOW });
  // Under 78 width, providers stack vertical and starts with heading
  assert.match(narrow, /Providers/);
  // Ensure no ANSI when color false
  assert.doesNotMatch(narrow, /\u001b\[/);
});
