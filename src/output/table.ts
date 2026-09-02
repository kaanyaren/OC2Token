import {
  allWindowKinds,
  normalizeDashboardSnapshot,
  type BreakdownTotal,
  type DashboardSnapshotInput,
} from "../dashboard/render/types.js";
import {
  formatCoverage,
  formatExactTokenCount,
  safeIdentifier,
} from "../dashboard/render/format.js";

function tableRow(columns: ReadonlyArray<string>, widths: ReadonlyArray<number>): string {
  return columns.map((column, index) => column.padEnd(widths[index] ?? column.length)).join("  ");
}

function renderSection(title: string, values: ReadonlyArray<BreakdownTotal>): string[] {
  const lines = [title];
  if (values.length === 0) return [...lines, "  (none)"];

  const rows = values.slice(0, 20).map((item) => [
    item.provider
      ? `${safeIdentifier(item.provider)}/${safeIdentifier(item.name)}`
      : safeIdentifier(item.name),
    formatExactTokenCount(item.totals.recorded_total),
    formatExactTokenCount(item.totals.input),
    formatExactTokenCount(item.totals.output + item.totals.reasoning),
    formatExactTokenCount(item.totals.cacheRead + item.totals.cacheWrite),
  ]);
  const widths = [
    Math.max("Name".length, ...rows.map((row) => row[0].length)),
    Math.max("Recorded".length, ...rows.map((row) => row[1].length)),
    Math.max("In".length, ...rows.map((row) => row[2].length)),
    Math.max("Out".length, ...rows.map((row) => row[3].length)),
    Math.max("Cache".length, ...rows.map((row) => row[4].length)),
  ];
  lines.push(tableRow(["Name", "Recorded", "In", "Out", "Cache"], widths));
  lines.push(tableRow(widths.map((width) => "-".repeat(width)), widths));
  lines.push(...rows.map((row) => tableRow(row, widths)));
  if (values.length > rows.length) lines.push(`  +${values.length - rows.length} more`);
  return lines;
}

/** Deterministic non-ANSI table for pipes, logs, and explicit table mode. */
export function renderTable(input: DashboardSnapshotInput): string {
  const snapshot = normalizeDashboardSnapshot(input);
  const rows: string[][] = [
    ["Window", "Recorded", "In", "Out", "Cache"],
  ];
  for (const kind of allWindowKinds()) {
    const totals = snapshot.windows[kind].totals;
    rows.push([
      kind === "hour" ? "Last hour" : kind === "day" ? "Today" : "This week",
      formatExactTokenCount(totals.recorded_total),
      formatExactTokenCount(totals.input),
      formatExactTokenCount(totals.output + totals.reasoning),
      formatExactTokenCount(totals.cacheRead + totals.cacheWrite),
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
