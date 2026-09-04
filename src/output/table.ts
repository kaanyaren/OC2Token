import {
  allWindowKinds,
  normalizeDashboardSnapshot,
  type BreakdownTotal,
  type DashboardSnapshotInput,
} from "../dashboard/render/types.js";
import {
  formatCost,
  formatCoverage,
  formatExactTokenCount,
  safeIdentifier,
  TABLE_ROW_CAP,
} from "../dashboard/render/format.js";

function tableRow(columns: ReadonlyArray<string>, widths: ReadonlyArray<number>): string {
  return columns.map((column, index) => column.padEnd(widths[index] ?? column.length)).join("  ");
}

function renderSection(title: string, values: ReadonlyArray<BreakdownTotal>): string[] {
  // Merges match the dashboard: Out = output + reasoning, Cache =
  // cacheRead + cacheWrite. Raw five-component splits are in stable JSON.
  // Cap is TABLE_ROW_CAP (20) for piped/log completeness; the interactive
  // dashboard caps at DASHBOARD_ROW_CAP (12) for TTY height. Intentional.
  const lines = [title];
  if (values.length === 0) return [...lines, "  (none)"];

  const rows = values.slice(0, TABLE_ROW_CAP).map((item) => {
    const prov = item.provider ? safeIdentifier(item.provider) : "";
    const nm = safeIdentifier(item.name);
    const display = prov && prov !== nm ? `${prov}/${nm}` : nm;
    return [
      display,
    formatExactTokenCount(item.totals.recorded_total),
    formatExactTokenCount(item.totals.input),
    formatExactTokenCount(item.totals.output + item.totals.reasoning),
    formatExactTokenCount(item.totals.cacheRead + item.totals.cacheWrite),
    formatCost(item.cost),
    ];
  });
  const widths = [
    Math.max("Name".length, ...rows.map((row) => row[0].length)),
    Math.max("Recorded".length, ...rows.map((row) => row[1].length)),
    Math.max("In".length, ...rows.map((row) => row[2].length)),
    Math.max("Out".length, ...rows.map((row) => row[3].length)),
    Math.max("Cache".length, ...rows.map((row) => row[4].length)),
    Math.max("Cost".length, ...rows.map((row) => row[5].length)),
  ];
  lines.push(tableRow(["Name", "Recorded", "In", "Out", "Cache", "Cost"], widths));
  lines.push(tableRow(widths.map((width) => "-".repeat(width)), widths));
  lines.push(...rows.map((row) => tableRow(row, widths)));
  if (values.length > rows.length) lines.push(`  +${values.length - rows.length} more`);
  return lines;
}

/** Deterministic non-ANSI table for pipes, logs, and explicit table mode. */
export function renderTable(input: DashboardSnapshotInput): string {
  const snapshot = normalizeDashboardSnapshot(input);
  const rows: string[][] = [
    ["Window", "Recorded", "In", "Out", "Cache", "Cost"],
  ];
  for (const kind of allWindowKinds()) {
    const win = snapshot.windows[kind];
    const totals = win.totals;
    rows.push([
      kind === "hour" ? "Last hour" : kind === "day" ? "Today" : "This week",
      formatExactTokenCount(totals.recorded_total),
      formatExactTokenCount(totals.input),
      formatExactTokenCount(totals.output + totals.reasoning),
      formatExactTokenCount(totals.cacheRead + totals.cacheWrite),
      formatCost(win.cost),
    ]);
  }
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );
  const status = snapshot.stale
    ? "STALE"
    : snapshot.coverage.complete
      ? "COMPLETE"
      : "PARTIAL";
  // Unified source is explicit when multiple providers contribute; normalize ensures "unified" even for legacy snapshots
  const displaySource = snapshot.providers.length > 1 ? "unified" : snapshot.source;
  const sortedProviders = [...snapshot.providers].sort(
    (a, b) => b.totals.recorded_total - a.totals.recorded_total || a.name.localeCompare(b.name),
  );
  const sortedProjects = [...snapshot.projects].sort(
    (a, b) => b.totals.recorded_total - a.totals.recorded_total || a.name.localeCompare(b.name),
  );
  const lines = [
    "OpenCode 2 Token Usage",
    `Source: ${safeIdentifier(displaySource)}  Version: ${safeIdentifier(snapshot.version)}`,
    `Status: ${status}  Coverage: ${formatCoverage(snapshot.coverage, snapshot.stale)}`,
    "",
    tableRow(rows[0], widths),
    tableRow(rows[0].map((column) => "-".repeat(column.length)), widths),
    ...rows.slice(1).map((row) => tableRow(row, widths)),
    "",
    ...renderSection("Models", snapshot.models),
    "",
    ...renderSection("Providers", sortedProviders),
    "",
    ...renderSection("Projects", sortedProjects),
  ];
  return lines.join("\n");
}

export const renderNonTTYTable = renderTable;
