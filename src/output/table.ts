import {
  allWindowKinds,
  normalizeDashboardSnapshot,
  type BreakdownTotal,
  type DashboardSnapshotInput,
} from "../dashboard/render/types.js";
import {
  formatCoverage,
  formatExactTokenCount,
  formatTokenBreakdown,
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
    formatTokenBreakdown(item.totals),
  ]);
  const widths = [
    Math.max("Name".length, ...rows.map((row) => row[0].length)),
    Math.max("Recorded".length, ...rows.map((row) => row[1].length)),
    Math.max("Components".length, ...rows.map((row) => row[2].length)),
  ];
  lines.push(tableRow(["Name", "Recorded", "Components"], widths));
  lines.push(tableRow(["----", "--------", "----------"], widths));
  lines.push(...rows.map((row) => tableRow(row, widths)));
  if (values.length > rows.length) lines.push(`  +${values.length - rows.length} more`);
  return lines;
}

/** Deterministic non-ANSI table for pipes, logs, and explicit table mode. */
export function renderTable(input: DashboardSnapshotInput): string {
  const snapshot = normalizeDashboardSnapshot(input);
  const rows: string[][] = [
    ["Window", "Recorded", "Input", "Output", "Reasoning", "Cache read", "Cache write"],
  ];
  for (const kind of allWindowKinds()) {
    const totals = snapshot.windows[kind].totals;
    rows.push([
      kind === "hour" ? "Last hour" : kind === "day" ? "Today" : "This week",
      formatExactTokenCount(totals.recorded_total),
      formatExactTokenCount(totals.input),
      formatExactTokenCount(totals.output),
      formatExactTokenCount(totals.reasoning),
      formatExactTokenCount(totals.cacheRead),
      formatExactTokenCount(totals.cacheWrite),
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
  const lines = [
    "OpenCode 2 Token Usage",
    `Source: ${safeIdentifier(snapshot.source)}  Version: ${safeIdentifier(snapshot.version)}`,
    `Status: ${status}  Coverage: ${formatCoverage(snapshot.coverage, snapshot.stale)}`,
    "",
    tableRow(rows[0], widths),
    tableRow(rows[0].map((column) => "-".repeat(column.length)), widths),
    ...rows.slice(1).map((row) => tableRow(row, widths)),
    "",
    ...renderSection("Models", snapshot.models),
    "",
    ...renderSection("Providers", snapshot.providers),
  ];
  return lines.join("\n");
}

export const renderNonTTYTable = renderTable;
