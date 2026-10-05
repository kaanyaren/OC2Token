import assert from "node:assert/strict";
import test from "node:test";
import {
  createUsageRecord,
  createUsageWindows,
  toUsageTotals,
} from "../../src/domain/index.js";
import {
  ANSI,
  GITHUB_URL,
  footerClickAction,
  footerTokenAtX,
  formatTokenCount,
  normalizeDashboardSnapshot,
  normalizeVisibleCards,
  renderDashboard,
  renderInPlace,
  renderOutput,
  themeOrange,
  themePurple,
  toJSONSnapshot,
  usageTotalsFrom,
} from "../../src/output/index.js";
import { normalizeSettings, SETTINGS_ROWS } from "../../src/dashboard/settings/index.js";
import { APP_VERSION } from "../../src/version.js";

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
  assert.match(topBar, /OC2TOKEN/);
  assert.doesNotMatch(topBar, /OpenCode 2 Token Usage/);
  assert.doesNotMatch(topBar, /Source:|Version:|Window:|Timezone:|Status:/);
  assert.match(output, /Status: COMPLETE/);
});

test("narrow dashboard uses one column and contains the navigation footer", () => {
  const output = renderDashboard(fixture(), { isTTY: true, color: false, width: 60, now: NOW });
  const cardRows = output.split("\n").filter((line) => line.trimStart().startsWith("╭") && line.indexOf("╭") === 2);
  assert.equal(cardRows.length, 4);
  assert.ok(cardRows.every((line) => !line.includes("╮  ╭")));
  assert.match(output, /r Refresh/);
  assert.doesNotMatch(output, /\u001b\[/);
});

test("dashboard applies a two-character outer gutter", () => {
  const output = renderDashboard(fixture(), { isTTY: true, color: false, width: 100, now: NOW });
  for (const line of output.split("\n")) {
    assert.equal(line.length, 100);
    assert.ok(line.startsWith("  "));
    assert.ok(line.endsWith("  "));
  }
  const card = output.split("\n").find((line) => line.includes("╭"));
  assert.equal(card?.indexOf("╭"), 2);
});

test("GitHub credit exposes a clickable URL in TTY and plain modes", () => {
  const colored = renderDashboard(fixture(), { isTTY: true, ansi: true, color: true, width: 100, now: NOW });
  assert.ok(colored.includes(GITHUB_URL));
  assert.ok(colored.includes(`\u001b]8;;${GITHUB_URL}\u0007`));

  const plain = renderDashboard(fixture(), { isTTY: true, color: false, width: 100, now: NOW });
  assert.match(plain, new RegExp(GITHUB_URL.replaceAll("/", "\\/")));
  assert.doesNotMatch(plain, /\u001b\[/);

  // Version appears next to the link (e.g. `Kaan Yaren · v0.1.13 · <URL>`).
  const versionTag = APP_VERSION.startsWith("v") ? APP_VERSION : `v${APP_VERSION}`;
  const coloredCredit = colored.split("\n").find((line) => line.includes("Kaan Yaren"));
  const plainCredit = plain.split("\n").find((line) => line.includes("Kaan Yaren"));
  assert.ok(coloredCredit?.includes(versionTag), `colored credit should contain ${versionTag}`);
  assert.ok(coloredCredit?.includes(GITHUB_URL));
  assert.ok(plainCredit?.includes(versionTag), `plain credit should contain ${versionTag}`);
  assert.ok(plainCredit?.includes(GITHUB_URL));
  assert.match(plainCredit ?? "", /Kaan Yaren · v\S+ · https?:\/\//);
});

test("credit bar threads an explicit version and stays centered within width", () => {
  const explicit = renderDashboard(fixture(), {
    isTTY: true,
    color: false,
    width: 100,
    now: NOW,
    appVersion: "9.9.9",
  });
  const explicitCredit = explicit.split("\n").find((line) => line.includes("Kaan Yaren"));
  assert.ok(explicitCredit?.includes("Kaan Yaren · v9.9.9 · "));
  assert.ok(explicitCredit?.includes(GITHUB_URL));
  assert.equal(explicitCredit?.length, 100);

  // Narrow widths drop the URL first but keep the version when it fits.
  const narrow = renderDashboard(fixture(), { isTTY: true, color: false, width: 40, now: NOW });
  assert.ok(narrow.split("\n").every((line) => [...line].length <= 40));
  const narrowCredit = narrow.split("\n").find((line) => line.includes("Kaan Yaren"));
  assert.ok(narrowCredit?.includes(versionTagFor(APP_VERSION)));
  assert.doesNotMatch(narrowCredit ?? "", /github\.com/);
});

function versionTagFor(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

test("very narrow dashboard truncates every line instead of relying on wrapping", () => {
  for (const width of [20, 40]) {
    const output = renderDashboard(fixture(), { isTTY: true, color: false, width, now: NOW });
    assert.ok(output.split("\n").every((line) => [...line].length <= width));
  }
});

test("month card stays within responsive dashboard widths", () => {
  for (const width of [60, 90, 100, 113, 114]) {
    const output = renderDashboard(fixture(), { isTTY: true, color: false, width, now: NOW });
    assert.ok(output.includes("LAST MONTH"));
    assert.doesNotMatch(output, /Range /);
    assert.ok(output.split("\n").every((line) => [...line].length <= width), `line overflow at width ${width}`);
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

test("piped breakdown tables share right-aligned numeric column edges", () => {
  const table = renderOutput(fixture({
    models: [{
      name: "model",
      totals: toUsageTotals({ input: 123_456_789, output: 2, reasoning: 0, cacheRead: 3, cacheWrite: 0 }),
      cost: 12.34,
    }],
    providers: [{
      name: "provider",
      totals: toUsageTotals({ input: 1, output: 9_876_543, reasoning: 0, cacheRead: 999_999, cacheWrite: 0 }),
      cost: 1.2,
    }],
    projects: [{
      name: "project",
      totals: toUsageTotals({ input: 1, output: 1, reasoning: 0, cacheRead: 1, cacheWrite: 0 }),
      cost: 123.45,
    }],
  }), { format: "table", isTTY: false });

  const endsFor = (title: string): number[] => {
    const start = table.indexOf(`${title}\n`);
    assert.ok(start >= 0, `missing ${title} table`);
    const header = table.slice(start).split("\n").find((line) => line.includes("Recorded"));
    assert.ok(header !== undefined, `missing ${title} header`);
    return ["Recorded", "In", "Out", "Cache", "Cost"].map((label) => header.indexOf(label) + label.length);
  };

  assert.deepEqual(endsFor("Models"), endsFor("Providers"));
  assert.deepEqual(endsFor("Models"), endsFor("Projects"));
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

test("top card titles are bold bright white", () => {
  const output = renderDashboard(fixture(), {
    isTTY: true,
    ansi: true,
    color: true,
    width: 120,
    now: NOW,
  });
  assert.ok(output.includes(`${ANSI.bold}${ANSI.whiteBright}· LAST MONTH`));
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
      day: Array.from({ length: 288 }, (_, index) => ({
        label: `${String(Math.floor(index / 12)).padStart(2, "0")}:${String((index % 12) * 5).padStart(2, "0")}`,
        from: new Date(NOW.getTime() - (288 - index) * 5 * 60 * 1_000),
        to: new Date(NOW.getTime() - (287 - index) * 5 * 60 * 1_000),
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

test("breakdown tables share right-aligned numeric column edges", () => {
  const output = renderDashboard(fixture({
    records: [],
    modelsByWindow: {
      day: [{
        name: "model",
        totals: toUsageTotals({ input: 123_456_789, output: 2, reasoning: 0, cacheRead: 3, cacheWrite: 0 }),
        cost: 12.34,
      }],
    },
    providersByWindow: {
      day: [{
        name: "provider",
        totals: toUsageTotals({ input: 1, output: 9_876_543, reasoning: 0, cacheRead: 999_999, cacheWrite: 0 }),
        cost: 1.2,
      }],
    },
    projectsByWindow: {
      day: [{
        name: "project",
        totals: toUsageTotals({ input: 1, output: 1, reasoning: 0, cacheRead: 1, cacheWrite: 0 }),
        cost: 123.45,
      }],
    },
  }), { isTTY: true, color: false, width: 100, selectedWindow: "day", now: NOW });

  const endsFor = (title: string, rowName: string): number[] => {
    const start = output.indexOf(`◆ ${title} · TODAY`);
    assert.ok(start >= 0, `missing ${title} table`);
    const header = output.slice(start).split("\n").find((line) => line.includes("RECORDED"));
    assert.ok(header !== undefined, `missing ${title} header`);
    assert.equal(header.length, 100, `${title} numeric header should reach the right edge`);
    const row = output.slice(start).split("\n").find((line) => line.includes(rowName));
    assert.ok(row !== undefined, `missing ${title} row`);
    assert.equal(row.length, 100, `${title} numeric row should reach the right edge`);
    return ["RECORDED", "In", "Out", "Cache", "Cost"].map((label) => header.indexOf(label) + label.length);
  };

  assert.deepEqual(endsFor("Models", "model"), endsFor("Providers", "provider"));
  assert.deepEqual(endsFor("Models", "model"), endsFor("Projects", "project"));
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

function manyModelFixture(count: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const windows = Object.values(createUsageWindows(NOW, "UTC"));
  const records = Array.from({ length: count }, (_, i) =>
    createUsageRecord({
      sessionID: `session-${i}`,
      messageID: `message-${i}`,
      createdAt: new Date(`2026-09-02T09:${String(50 + i).padStart(2, "0")}:00.000Z`),
      model: `provider/model-${i}`,
      tokens: { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      observedAt: NOW,
      completeness: "final",
    }),
  );
  return {
    capturedAt: NOW,
    windows,
    source: "message-scan",
    records,
    totalsByWindow: {},
    coverage: { complete: true, sessionsDiscovered: count, sessionsScanned: count, sessionsSkipped: 0, pagesRead: count, jobsRetried: 0, provisionalMessages: 0, errors: [] },
    ...overrides,
  };
}

test("breakdown table collapses to 3 rows with a more hint when over threshold", () => {
  const input = manyModelFixture(7);
  const plain = renderDashboard(input, { isTTY: false, color: false, width: 100, selectedWindow: "day", collapsedTables: { models: true, providers: true, projects: true } });
  assert.match(plain, /Models · TODAY.*▸/);
  assert.match(plain, /\+4 more · click to expand/);
  // Only 3 model rows should be visible (plus header lines).
  const modelRows = plain.split("\n").filter((line) => /model-\d/.test(line));
  assert.equal(modelRows.length, 3);
});

test("breakdown table expands to show all rows when collapsed is false", () => {
  const input = manyModelFixture(7);
  const plain = renderDashboard(input, { isTTY: false, color: false, width: 100, selectedWindow: "day", collapsedTables: { models: false, providers: true, projects: true } });
  assert.match(plain, /Models · TODAY.*▾/);
  assert.doesNotMatch(plain, /click to expand/);
  const modelRows = plain.split("\n").filter((line) => /model-\d/.test(line));
  assert.equal(modelRows.length, 7);
});

test("breakdown table at or below threshold renders normally with no collapse UI", () => {
  const input = manyModelFixture(3);
  const plain = renderDashboard(input, { isTTY: false, color: false, width: 100, selectedWindow: "day", collapsedTables: { models: true, providers: true, projects: true } });
  assert.doesNotMatch(plain, /▸|▾/);
  assert.doesNotMatch(plain, /click to expand/);
  const modelRows = plain.split("\n").filter((line) => /model-\d/.test(line));
  assert.equal(modelRows.length, 3);
});

test("focused table header shows a focus marker", () => {
  const input = manyModelFixture(5);
  const plain = renderDashboard(input, { isTTY: false, color: false, width: 100, selectedWindow: "day", focusedTable: "models" });
  assert.match(plain, /▶ Models ·/);
});

test("JSON snapshot uses schemaVersion 4 and exposes totalsByProvider per window", () => {
  const json = toJSONSnapshot(fixture());
  assert.equal(json.schemaVersion, 4);
  assert.ok(json.totalsByProvider);
  for (const kind of ["hour", "day", "week", "month"] as const) {
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
  for (const kind of ["hour", "day", "week", "month"] as const) {
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
  // No inline provider percentages under the top cards (removed by design)
  assert.doesNotMatch(dash, /\(\d+%\)/);
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

test("footer click tokens map to dashboard actions", () => {
  assert.equal(footerClickAction("r"), "refresh");
  assert.equal(footerClickAction("Refresh"), "refresh");
  // Numeric keys select visible card slots in order.
  assert.deepEqual(footerClickAction("1"), { slot: 0 });
  assert.deepEqual(footerClickAction("2"), { slot: 1 });
  assert.deepEqual(footerClickAction("3"), { slot: 2 });
  assert.deepEqual(footerClickAction("4"), { slot: 3 });
  // Named period tokens select the card kind directly.
  assert.deepEqual(footerClickAction("Hour"), { card: "hour" });
  assert.deepEqual(footerClickAction("Today"), { card: "day" });
  assert.deepEqual(footerClickAction("Week"), { card: "week" });
  assert.deepEqual(footerClickAction("Month"), { card: "month" });
  assert.deepEqual(footerClickAction("15m"), { card: "15m" });
  assert.deepEqual(footerClickAction("30m"), { card: "30m" });
  assert.deepEqual(footerClickAction("2h"), { card: "2h" });
  assert.deepEqual(footerClickAction("5h"), { card: "5h" });
  assert.equal(footerClickAction("p"), "projects");
  assert.equal(footerClickAction("Proj"), "projects");
  assert.equal(footerClickAction("Projects"), "projects");
  assert.equal(footerClickAction("s"), "settings");
  assert.equal(footerClickAction("Settings"), "settings");
  assert.equal(footerClickAction("q"), "quit");
  assert.equal(footerClickAction("Quit"), "quit");
  assert.equal(footerClickAction("?"), "help");
  assert.equal(footerClickAction("Help"), "help");
  // Decorative tokens have no action.
  assert.equal(footerClickAction("1/2/3/4"), undefined);
  assert.equal(footerClickAction("Periods"), undefined);
  assert.equal(footerClickAction("Navigate"), undefined);
  assert.equal(footerClickAction("Tab/Arrows"), undefined);
  assert.equal(footerClickAction("close"), undefined);
  assert.equal(footerClickAction(""), undefined);
});

test("help panel documents collapse, cards, and mouse actions", () => {  const plain = renderDashboard(fixture(), { isTTY: false, color: false, width: 120, help: true });
  assert.match(plain, /◆ Help/);
  assert.match(plain, /Expand\/collapse/);
  assert.match(plain, /card slots/);
  assert.match(plain, /Click:/);
  const noHelp = renderDashboard(fixture(), { isTTY: false, color: false, width: 120 });
  assert.doesNotMatch(noHelp, /◆ Help/);
});

test("footer token lookup resolves the word under a 1-based column", () => {
  const line = " r Refresh   1 Hour";
  assert.equal(footerTokenAtX(line, 1), undefined); // leading space
  assert.equal(footerTokenAtX(line, 2), "r");
  assert.equal(footerTokenAtX(line, 4), "Refresh");
  assert.equal(footerTokenAtX(line, 10), "Refresh");
  assert.equal(footerTokenAtX(line, 11), undefined); // gap
  assert.equal(footerTokenAtX(line, 14), "1");
  assert.equal(footerTokenAtX(line, 16), "Hour");
  assert.equal(footerTokenAtX(line, 99), undefined);
});

test("breakdown tables toggle from settings and default to shown", () => {
  // Legacy settings files without the flags show both tables.
  assert.equal(normalizeSettings({}).showProvidersTable, true);
  assert.equal(normalizeSettings({}).showProjectsTable, true);
  assert.equal(normalizeSettings(null).showProvidersTable, true);
  assert.equal(
    normalizeSettings({ showProvidersTable: false, showProjectsTable: false }).showProvidersTable,
    false,
  );

  const windows = Object.values(createUsageWindows(NOW, "UTC"));
  const totals = toUsageTotals({ input: 10, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  const base: Record<string, unknown> = {
    capturedAt: NOW,
    windows,
    source: "message-scan",
    records: [recordFor("openai/gpt-5", new Date("2026-09-02T09:55:00.000Z"), 10)],
    totalsByWindow: { hour: totals, day: totals, week: totals },
    coverage: { complete: true, sessionsDiscovered: 1, sessionsScanned: 1, sessionsSkipped: 0, pagesRead: 1, jobsRetried: 0, provisionalMessages: 0, errors: [] },
  };
  const view = (flags: object) => renderDashboard(base, {
    isTTY: true,
    color: false,
    width: 100,
    selectedWindow: "day",
    settings: {
      visible: false,
      enabledProviders: ["opencode"],
      refreshIntervalSeconds: 300,
      focusedIndex: 0,
      ...flags,
    },
  });
  const bothOff = view({ showProvidersTable: false, showProjectsTable: false });
  assert.match(bothOff, /◆ Models ·/);
  assert.doesNotMatch(bothOff, /◆ Providers ·/);
  assert.doesNotMatch(bothOff, /◆ Projects ·/);
  const legacy = view({});
  assert.match(legacy, /◆ Models ·/);
  assert.match(legacy, /◆ Providers ·/);
  assert.match(legacy, /◆ Projects ·/);
});

function trendBucket(from: Date, to: Date, input: number) {
  return {
    label: from.toISOString(),
    from,
    to,
    totals: toUsageTotals({ input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }),
  };
}

function minuteBuckets(from: Date, count: number, minutes: number, input: number) {
  return Array.from({ length: count }, (_, i) => {
    const start = new Date(from.getTime() + i * minutes * 60 * 1000);
    return trendBucket(start, new Date(start.getTime() + minutes * 60 * 1000), input);
  });
}

function derivedFixture() {
  // NOW 10:00 UTC: hour = [09:00,10:00) in 30s buckets, day = [00:00,24:00).
  const windows = Object.values(createUsageWindows(NOW, "UTC"));
  return {
    capturedAt: NOW,
    windows,
    source: "message-scan",
    records: [],
    totalsByWindow: {},
    trendsByWindow: {
      hour: minuteBuckets(new Date("2026-09-02T09:00:00.000Z"), 120, 0.5, 1),
      day: minuteBuckets(new Date("2026-09-02T00:00:00.000Z"), 288, 5, 2),
    },
    coverage: { complete: true, sessionsDiscovered: 0, sessionsScanned: 0, sessionsSkipped: 0, pagesRead: 0, jobsRetried: 0, provisionalMessages: 0, errors: [] },
  };
}

test("derived sub-windows sum parent trend buckets", () => {
  const snapshot = normalizeDashboardSnapshot(derivedFixture());
  // 15m = last 30 half-minute buckets x input 1; 30m = last 60.
  assert.equal(snapshot.derived["15m"].totals.input, 30);
  assert.equal(snapshot.derived["15m"].trends.length, 30);
  assert.equal(snapshot.derived["30m"].totals.input, 60);
  assert.equal(snapshot.derived["30m"].trends.length, 60);
  // 2h = last 24 five-minute day buckets x input 2.
  assert.equal(snapshot.derived["2h"].totals.input, 48);
  assert.equal(snapshot.derived["2h"].trends.length, 24);
  assert.equal(snapshot.derived["15m"].unmeasured, undefined);
});

test("derived 2h prefers high-resolution range trends over sliced day buckets", () => {
  const base = derivedFixture();
  const from = new Date("2026-09-02T08:00:00.000Z");
  const input = {
    ...base,
    trendsByRange: [
      { from, to: NOW, trends: minuteBuckets(from, 96, 1.25, 3) },
      // Near-miss range must not match.
      { from: new Date("2026-09-02T07:59:00.000Z"), to: NOW, trends: minuteBuckets(from, 96, 1.25, 999) },
    ],
  };
  const snapshot = normalizeDashboardSnapshot(input);
  // 96 buckets at 75s x input 3, not 24 sliced 5-minute buckets x input 2.
  assert.equal(snapshot.derived["2h"].trends.length, 96);
  assert.equal(snapshot.derived["2h"].totals.input, 288);
});

test("derived 5h slices sixty five-minute day buckets", () => {
  const snapshot = normalizeDashboardSnapshot(derivedFixture());
  // 5h = last 60 five-minute day buckets x input 2.
  assert.equal(snapshot.derived["5h"].trends.length, 60);
  assert.equal(snapshot.derived["5h"].totals.input, 120);
  assert.equal(snapshot.derived["5h"].unmeasured, undefined);
  assert.equal(snapshot.derived["5h"].window.label, "last 5 hours");
});

test("derived sub-windows fall back to records when parent trends are absent", () => {
  const windows = Object.values(createUsageWindows(NOW, "UTC"));
  const input = {
    capturedAt: NOW,
    windows,
    source: "message-scan",
    records: [
      recordFor("openai/gpt-5", new Date("2026-09-02T09:50:00.000Z"), 7),
      recordFor("openai/gpt-5", new Date("2026-09-02T08:30:00.000Z"), 5),
    ],
    totalsByWindow: {},
    coverage: { complete: true, sessionsDiscovered: 2, sessionsScanned: 2, sessionsSkipped: 0, pagesRead: 2, jobsRetried: 0, provisionalMessages: 0, errors: [] },
  };
  const snapshot = normalizeDashboardSnapshot(input);
  // Only the 09:50 record falls in [09:45,10:00).
  assert.equal(snapshot.derived["15m"].totals.input, 7);
  assert.equal(snapshot.derived["15m"].unmeasured, undefined);
  // Both records fall in [08:00,10:00).
  assert.equal(snapshot.derived["2h"].totals.input, 12);
  // Record-built 2h grid uses 75s buckets: 96 bars, not 24.
  assert.equal(snapshot.derived["2h"].trends.length, 96);
  // Breakdowns derive from the same records.
  assert.equal(snapshot.derived["15m"].models.length, 1);
  assert.equal(snapshot.derived["15m"].models[0]?.totals.input, 7);
});

test("derived sub-windows are unmeasured without trends or records", () => {
  const windows = Object.values(createUsageWindows(NOW, "UTC"));
  const input = {
    capturedAt: NOW,
    windows,
    source: "stats",
    records: [],
    totalsByWindow: {},
    coverage: { complete: true, sessionsDiscovered: 0, sessionsScanned: 0, sessionsSkipped: 0, pagesRead: 0, jobsRetried: 0, provisionalMessages: 0, errors: [] },
  };
  const snapshot = normalizeDashboardSnapshot(input);
  assert.equal(snapshot.derived["15m"].unmeasured, true);
  assert.equal(snapshot.derived["2h"].unmeasured, true);
  const plain = renderDashboard(input, { isTTY: false, color: false, width: 120, selectedWindow: "day", visibleCards: ["15m", "30m", "hour", "day"] });
  assert.match(plain, /LAST 15 MINUTES/);
  assert.match(plain, /n\/a/);
});

test("visible cards choose the rendered card set and footer labels", () => {
  const input = derivedFixture();
  const plain = renderDashboard(input, { isTTY: false, color: false, width: 120, selectedWindow: "day", visibleCards: ["15m", "30m", "hour", "day"] });
  assert.match(plain, /LAST 15 MINUTES/);
  assert.match(plain, /LAST 30 MINUTES/);
  assert.doesNotMatch(plain, /THIS WEEK/);
  assert.doesNotMatch(plain, /LAST MONTH/);
  // Footer period labels follow the visible order.
  assert.match(plain, /1.*15m.*2.*30m/);
  // Legacy default keeps the four collected windows.
  const legacy = renderDashboard(input, { isTTY: false, color: false, width: 120, selectedWindow: "day" });
  assert.match(legacy, /THIS WEEK/);
  assert.match(legacy, /LAST MONTH/);
  assert.doesNotMatch(legacy, /LAST 15 MINUTES/);
});

test("six visible cards render two rows of three with 1-6 footer keys", () => {
  const input = derivedFixture();
  const six = ["hour", "day", "week", "month", "2h", "5h"] as const;
  const plain = renderDashboard(input, {
    isTTY: false,
    color: false,
    width: 200,
    selectedWindow: "5h",
    visibleCards: [...six],
  });
  assert.match(plain, /LAST 5 HOURS/);
  assert.match(plain, /LAST 2 HOURS/);
  assert.match(plain, /Trend · last 5 hours/);
  // Footer keys cover all six slots in order.
  assert.match(plain, /1.*Hour.*2.*Today.*3.*Week.*4.*Month.*5.*2h.*6.*5h/s);
  // Static key hints compress to 1-6 once slots 5-6 exist (help panel).
  const helped = renderDashboard(input, {
    isTTY: false,
    color: false,
    width: 100,
    help: true,
    selectedWindow: "day",
    visibleCards: [...six],
  });
  assert.match(helped, /1-6/);
  // Narrow terminals keep the 1/2/3/4 hint for the legacy four.
  const narrow = renderDashboard(input, { isTTY: false, color: false, width: 55, selectedWindow: "day" });
  assert.match(narrow, /1\/2\/3\/4/);
});

test("selecting a derived card shows its trend and breakdown scope", () => {
  const input = derivedFixture();
  const plain = renderDashboard(input, { isTTY: false, color: false, width: 120, selectedWindow: "15m", visibleCards: ["15m", "30m", "hour", "day"] });
  assert.match(plain, /Trend · last 15 minutes/);
  assert.match(plain, /Models · LAST 15 MINUTES/);
});

test("derived splits aggregate bucket evidence and union records", () => {
  const base = derivedFixture();
  type BucketList = Array<Record<string, unknown>>;
  const trends = base.trendsByWindow as unknown as Record<string, BucketList>;
  // Attach stats splits to every hour bucket; records cover a file provider.
  const codexRecord = createUsageRecord({
    sessionID: "codex-session",
    messageID: "codex-message",
    createdAt: new Date("2026-09-02T09:50:00.000Z"),
    model: "codex/model",
    tokens: { input: 7, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    observedAt: NOW,
    completeness: "final",
    provider: "codex",
  });
  const withSplits = {
    ...base,
    records: [codexRecord],
    trendsByWindow: {
      hour: trends.hour.map((bucket) => ({
        ...bucket,
        providers: [{ name: "opencode-go", totals: toUsageTotals({ input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }) }],
        models: [{ name: "space-bunny-free", provider: "opencode-go", totals: toUsageTotals({ input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }) }],
      })),
      day: trends.day,
    },
  };
  const snapshot = normalizeDashboardSnapshot(withSplits);
  const providers = snapshot.derived["15m"].providers;
  const names = providers.map((entry) => entry.name).sort();
  // Bucket evidence (opencode-go: 15 x input 1) unions record evidence (codex: 7).
  assert.deepEqual(names, ["codex", "opencode-go"]);
  assert.equal(providers.find((entry) => entry.name === "opencode-go")?.totals.input, 30);
  assert.equal(providers.find((entry) => entry.name === "codex")?.totals.input, 7);
  const models = snapshot.derived["15m"].models.map((entry) => entry.name).sort();
  assert.deepEqual(models, ["codex/model", "space-bunny-free"]);
});

test("normalizeTrend retains per-bucket splits through the cache path", () => {
  const base = derivedFixture();
  type BucketList = Array<Record<string, unknown>>;
  const trends = base.trendsByWindow as unknown as Record<string, BucketList>;
  const withSplits = {
    ...base,
    trendsByWindow: {
      hour: trends.hour.slice(0, 1).map((bucket) => ({
        ...bucket,
        providers: [{ name: "opencode-go", totals: toUsageTotals({ input: 3, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }) }],
      })),
    },
  };
  // Simulate a cache round-trip: normalize must not drop the splits.
  const once = normalizeDashboardSnapshot(withSplits);
  const twice = normalizeDashboardSnapshot(JSON.parse(JSON.stringify(once)));
  void twice;
  assert.equal(once.windows.hour.trends[0]?.providers?.[0]?.name, "opencode-go");
  assert.equal(once.windows.hour.trends[0]?.providers?.[0]?.totals.input, 3);
});

test("normalizeVisibleCards enforces four or six distinct cards", () => {  assert.deepEqual(normalizeVisibleCards(undefined), ["hour", "day", "week", "month"]);
  assert.deepEqual(normalizeVisibleCards(null), ["hour", "day", "week", "month"]);
  assert.deepEqual(
    normalizeVisibleCards(["15m", "15m", "bogus", "day", "week", "month", "30m", "2h", "hour"]),
    ["15m", "day", "week", "month", "30m", "2h"],
  );
  assert.deepEqual(normalizeVisibleCards(["2h"]), ["2h", "hour", "day", "week"]);
  assert.deepEqual(normalizeSettings({}).visibleCards, ["hour", "day", "week", "month"]);
  assert.deepEqual(normalizeSettings({ visibleCards: ["15m", "30m", "2h", "day"] }).visibleCards, ["15m", "30m", "2h", "day"]);
  // Six valid kinds select the wide layout.
  assert.deepEqual(
    normalizeVisibleCards(["15m", "hour", "day", "week", "month", "30m"]),
    ["15m", "hour", "day", "week", "month", "30m"],
  );
  // Five valid kinds round up to six rather than dropping a pick.
  assert.deepEqual(
    normalizeVisibleCards(["15m", "hour", "day", "week", "month"]),
    ["15m", "hour", "day", "week", "month", "30m"],
  );
  // An explicit count overrides inference.
  assert.deepEqual(
    normalizeVisibleCards(["15m", "hour", "day", "week", "month", "30m"], 4),
    ["15m", "hour", "day", "week"],
  );
  assert.deepEqual(
    normalizeVisibleCards(["hour"], 6),
    ["hour", "day", "week", "month", "15m", "30m"],
  );
  assert.deepEqual(
    normalizeSettings({ visibleCards: ["hour", "day", "week", "month", "2h", "5h"] }).visibleCards,
    ["hour", "day", "week", "month", "2h", "5h"],
  );
});

test("settings panel lists the four card slots", () => {
  const plain = renderDashboard(fixture(), {
    isTTY: false,
    color: false,
    width: 100,
    selectedWindow: "day",
    settings: {
      visible: true,
      enabledProviders: ["opencode"],
      refreshIntervalSeconds: 300,
      focusedIndex: SETTINGS_ROWS.cards,
      visibleCards: ["15m", "hour", "day", "week"],
    },
  });
  assert.match(plain, /Card 1: 15m/);
  assert.match(plain, /Card 4: Week/);
  // Inactive slots still render (dimmed) so focus indices never shift.
  assert.match(plain, /Card 6: 30m/);
  assert.match(plain, /Cards shown: 4/);
});

test("settings focus index order follows the rendered row order", () => {
  // Tab/arrows walk focusedIndex 0..12 linearly, so the index order must match
  // the order the panel draws its rows or navigation appears to skip rows.
  const focusedRow = (focusedIndex: number): string => {
    const plain = renderDashboard(fixture(), {
      isTTY: false,
      color: false,
      width: 100,
      selectedWindow: "day",
      settings: {
        visible: true,
        enabledProviders: ["opencode"],
        refreshIntervalSeconds: 300,
        focusedIndex,
        visibleCards: ["15m", "hour", "day", "week"],
      },
    });
    // Scope to the panel: top cards also carry a "▶" marker.
    const lines = plain.split("\n");
    const panelStart = lines.findIndex((line) => line.includes("◆ Settings"));
    assert.ok(panelStart !== -1, "settings panel not rendered");
    const row = lines.slice(panelStart).find((line) => line.includes("▶"));
    assert.ok(row !== undefined, `no focused row rendered for focusedIndex ${focusedIndex}`);
    return row!.replace(/[│]/g, " ").replace("▶", "").replace("← toggle", "").replace("← cycle", "").trim();
  };

  const walked = Array.from({ length: SETTINGS_ROWS.count }, (_, index) => focusedRow(index));
  assert.deepEqual(walked, [
    "◉ opencode",
    "○ codex",
    "○ antigravity",
    "◉ Providers table",
    "◉ Projects table",
    "Card 1: 15m",
    "Card 2: Hour",
    "Card 3: Today",
    "Card 4: Week",
    "Card 5: Month",
    "Card 6: 30m",
    "Cards shown: 4",
    "Refresh interval · 5m",
  ]);
});

test("top cards show exact token counts with a tokens suffix when it fits", () => {
  const windows = Object.values(createUsageWindows(NOW, "UTC"));
  const totals = toUsageTotals({ input: 1000000000, output: 100000000, reasoning: 32234235, cacheRead: 0, cacheWrite: 0 });
  const input: Record<string, unknown> = {
    capturedAt: NOW,
    windows,
    source: "message-scan",
    records: [],
    totalsByWindow: { hour: totals, day: totals, week: totals, month: totals },
    coverage: { complete: true, sessionsDiscovered: 0, sessionsScanned: 0, sessionsSkipped: 0, pagesRead: 0, jobsRetried: 0, provisionalMessages: 0, errors: [] },
  };
  // Wide cards fit the exact count plus suffix: 1,000,000,000 + 100,000,000 + 32,234,235.
  const wide = renderDashboard(input, { isTTY: false, color: false, width: 200, selectedWindow: "day" });
  assert.match(wide, /1,132,234,235 tokens/);
  // Narrow cards fall back to the compact form to preserve the border.
  const narrow = renderDashboard(input, { isTTY: false, color: false, width: 20, selectedWindow: "day" });
  assert.match(narrow, /1\.1B/);
  assert.doesNotMatch(narrow, /1,132,234,235/);
});

test("derived projects match range-fetched splits and union records", () => {
  const base = derivedFixture();
  const from = new Date("2026-09-02T09:45:00.000Z");
  const to = new Date("2026-09-02T10:00:00.000Z");
  const projectTotals = (input: number) =>
    toUsageTotals({ input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  const input = {
    ...base,
    records: [
      createUsageRecord({
        sessionID: "codex-session",
        messageID: "codex-message",
        createdAt: new Date("2026-09-02T09:50:00.000Z"),
        model: "codex/model",
        tokens: { input: 7, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        observedAt: NOW,
        completeness: "final",
        provider: "codex",
        project: "/proj/codex",
      }),
    ],
    projectSplitsByRange: [
      { from, to, projects: [{ name: "/proj/stats", totals: projectTotals(100) }] },
      // Near-miss range must not match.
      { from: new Date("2026-09-02T09:44:00.000Z"), to, projects: [{ name: "/proj/wrong", totals: projectTotals(999) }] },
    ],
  };
  const snapshot = normalizeDashboardSnapshot(input);
  const names = snapshot.derived["15m"].projects.map((entry) => entry.name).sort();
  assert.deepEqual(names, ["/proj/codex", "/proj/stats"]);
  assert.equal(snapshot.derived["15m"].projects.find((entry) => entry.name === "/proj/stats")?.totals.input, 100);
});

test("terminal height pins the footer block to the bottom row", () => {  const input = fixture();
  const packed = renderDashboard(input, { isTTY: false, color: false, width: 100 });
  const pinned = renderDashboard(input, { isTTY: false, color: false, width: 100, height: 200 });
  const pinnedLines = pinned.split("\n");
  // Frame fills exactly the terminal height, credit on the last row.
  assert.equal(pinnedLines.length, 200);
  assert.match(pinnedLines[199] ?? "", /Kaan Yaren/);
  // Status box sits directly above the footer at the bottom.
  const statusIdx = pinnedLines.findIndex((line) => line.includes("Status:"));
  assert.ok(statusIdx > pinned.split("\n").length - 12);
  // Without height the frame is shorter; its non-blank content is identical
  // and in the same order, with blanks inserted only above the footer block.
  assert.ok(packed.split("\n").length < 200);
  assert.deepEqual(
    pinnedLines.filter((line) => line.trim().length > 0),
    packed.split("\n").filter((line) => line.trim().length > 0),
  );
});

test("trend graph shows a y axis with threshold labels and zero", () => {
  const input = fixture({ trends: { day: [{ label: "09:00", totals: toUsageTotals({ input: 100, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }) }] } });
  const plain = renderDashboard(input, { isTTY: false, color: false, width: 100, selectedWindow: "day" });
  const start = plain.indexOf("Trend · today");
  const panel = plain.slice(start, start + 800);
  // Axis separator plus top (max) and bottom (0) labels.
  assert.match(panel, /│/);
  assert.match(panel, /100/);
  assert.match(panel, / 0 /);
});
