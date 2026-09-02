import type { UsageWindowKind } from "../../domain/index.js";
import {
  ansiEnabled,
  colorEnabled,
  emphasis,
  paint,
  renderInPlace,
  statusColor,
  type AnsiOptions,
} from "./ansi.js";
import {
  coverageState,
  formatCoverage,
  formatNextRefresh,
  formatShortTimestamp,
  formatTokenBreakdown,
  formatTokenCount,
  formatWindowRange,
  safeIdentifier,
  safeLabel,
  stripAnsi,
} from "./format.js";
import {
  allWindowKinds,
  normalizeDashboardSnapshot,
  type BreakdownTotal,
  type DashboardRenderOptions,
  type DashboardSnapshotInput,
  type DashboardWindow,
} from "./types.js";

const CARD_MIN_WIDTH = 27;
const WIDE_LAYOUT_MIN_WIDTH = 90;

function lineWidth(value: string): number {
  return [...stripAnsi(value)].length;
}

function pad(value: string, width: number): string {
  const gap = Math.max(0, width - lineWidth(value));
  return value + " ".repeat(gap);
}

function truncate(value: string, width: number): string {
  const safe = safeLabel(value, width);
  return lineWidth(safe) <= width ? safe : [...safe].slice(0, Math.max(0, width - 1)).join("") + "…";
}

function border(width: number, left: string, fill: string, right: string): string {
  return left + fill.repeat(Math.max(0, width - 2)) + right;
}

function cardTitle(kind: UsageWindowKind): string {
  return kind === "hour" ? "LAST 60 MINUTES" : kind === "day" ? "TODAY" : "THIS WEEK";
}

function cardLines(kind: UsageWindowKind, window: DashboardWindow, width: number, color: boolean): string[] {
  const inner = Math.max(1, width - 2);
  const total = `Recorded  ${formatTokenCount(window.totals.recorded_total)}`;
  const first = pad(total, inner);
  const components = formatTokenBreakdown(window.totals);
  const lines = [
    border(width, "┌", `─`, "┐"),
    "│" + pad(cardTitle(kind), inner) + "│",
    "│" + pad(first, inner) + "│",
    "│" + pad(truncate(components, inner), inner) + "│",
    "│" + pad(`Range ${window.window.label}`, inner) + "│",
    border(width, "└", `─`, "┘"),
  ];
  if (!color) return lines;
  return lines.map((line, index) =>
    index === 1 ? paint(line, "\u001b[36m", color) : line,
  );
}

function composeCards(cards: string[][], gap = 2): string[] {
  const maxLines = Math.max(...cards.map((card) => card.length), 0);
  const widths = cards.map((card) => lineWidth(card[0] ?? ""));
  return Array.from({ length: maxLines }, (_, row) =>
    cards.map((card, index) => pad(card[row] ?? "", widths[index])).join(" ".repeat(gap)).trimEnd(),
  );
}

function renderHeader(
  snapshot: ReturnType<typeof normalizeDashboardSnapshot>,
  options: DashboardRenderOptions,
  color: boolean,
): string[] {
  const timezone = safeIdentifier(snapshot.windows.hour.window.timezone || "UTC");
  const state = coverageState(snapshot.coverage, snapshot.stale);
  const status = statusColor(formatCoverage(snapshot.coverage, snapshot.stale), state, color);
  const source = safeIdentifier(snapshot.source || "unknown");
  const version = safeIdentifier(snapshot.version || "unknown");
  const updated = formatShortTimestamp(snapshot.lastUpdated, timezone);
  const next = formatNextRefresh(snapshot.nextRefreshAt, options.now ?? snapshot.lastUpdated);
  const selected = options.selectedWindow ?? "day";
  const selectedWindow = snapshot.windows[selected].window;
  return [
    emphasis("OpenCode 2 Token Usage", color),
    `Source: ${source} · Version: ${version} · Range: ${safeLabel(selectedWindow.semantics)}`,
    `Window: ${safeLabel(selectedWindow.label)} · ${formatWindowRange(selectedWindow.from, selectedWindow.to, timezone)}`,
    `Timezone: ${timezone} · Updated: ${updated} · ${next}`,
    `Status: ${status} · Coverage: ${formatCoverage(snapshot.coverage, snapshot.stale)}`,
    "",
  ];
}

function renderTrend(
  snapshot: ReturnType<typeof normalizeDashboardSnapshot>,
  selected: UsageWindowKind,
  color: boolean,
  width: number,
): string[] {
  const trend = snapshot.windows[selected].trends;
  const title = `Trend · ${cardTitle(selected).toLowerCase()}`;
  if (trend.length === 0) return [emphasis(title, color), "  No trend data recorded."];

  const max = Math.max(...trend.map((bucket) => bucket.totals.recorded_total), 0);
  const labelWidth = Math.max(6, Math.min(18, Math.floor(width * 0.3)));
  const available = Math.max(1, Math.min(24, width - labelWidth - 12));
  return [
    emphasis(title, color),
    ...trend.map((bucket) => {
      const barLength = max === 0 ? 0 : Math.max(1, Math.round((bucket.totals.recorded_total / max) * available));
      return `  ${truncate(bucket.label, labelWidth).padEnd(labelWidth)} ${"▇".repeat(barLength).padEnd(available)} ${formatTokenCount(bucket.totals.recorded_total)}`;
    }),
  ];
}

function renderBreakdown(
  title: string,
  values: ReadonlyArray<BreakdownTotal>,
  color: boolean,
  width: number,
): string[] {
  const lines = [emphasis(title, color)];
  if (values.length === 0) {
    return [...lines, "  No breakdown data recorded."];
  }
  const visible = values.slice(0, 12);
  const nameWidth = Math.max(8, Math.min(42, Math.floor(width * 0.42)));
  for (const item of visible) {
    const name = item.provider ? `${safeIdentifier(item.provider)}/${safeIdentifier(item.name)}` : safeIdentifier(item.name);
    const details = width < 70 ? "" : `  ${formatTokenBreakdown(item.totals)}`;
    lines.push(`  ${truncate(name, nameWidth).padEnd(nameWidth)} ${formatTokenCount(item.totals.recorded_total).padStart(8)}${details}`);
  }
  if (values.length > visible.length) {
    lines.push(`  +${values.length - visible.length} more`);
  }
  return lines;
}

function renderFooter(help: boolean, color: boolean): string[] {
  if (help) {
    return [
      "",
      emphasis("Help", color),
      "  r/R Refresh now   1 Hour   2 Today   3 Week   Tab/Arrows Navigate",
      "  q Quit             ? Toggle help",
    ];
  }
  return [
    "",
    paint("r Refresh   1 Hour   2 Today   3 Week   Tab/Arrows Navigate   q Quit   ? Help", "\u001b[2m", color),
  ];
}

export function renderDashboard(
  input: DashboardSnapshotInput,
  options: DashboardRenderOptions = {},
): string {
  const snapshot = normalizeDashboardSnapshot(input);
  // Keep a small floor for borders, but never force a 40-column frame on a
  // narrower terminal. Content is truncated/stacked rather than relying on
  // terminal wrapping to preserve redraw geometry.
  const width = Math.max(20, options.width ?? 100);
  const color = colorEnabled(options);
  const selected = options.selectedWindow ?? "day";
  const lines = renderHeader(snapshot, options, color);
  const cardWidth = width >= WIDE_LAYOUT_MIN_WIDTH
    ? Math.max(CARD_MIN_WIDTH, Math.floor((width - 4) / 3))
    : Math.max(12, Math.min(CARD_MIN_WIDTH, width - 2));
  const cards = allWindowKinds().map((kind) => cardLines(kind, snapshot.windows[kind], cardWidth, color));

  if (width >= WIDE_LAYOUT_MIN_WIDTH && cards.length === 3) {
    lines.push(...composeCards(cards));
  } else {
    for (const card of cards) lines.push(...card, "");
  }

  lines.push("");
  lines.push(...renderTrend(snapshot, selected, color, width));
  lines.push("");
  lines.push(...renderBreakdown("Models", snapshot.models, color, width));
  lines.push(...renderBreakdown("Providers", snapshot.providers, color, width));
  if (snapshot.coverage.errors.length > 0) {
    lines.push("");
    lines.push(emphasis("Coverage errors", color));
    for (const error of snapshot.coverage.errors.slice(0, 5)) {
      lines.push(`  ${safeIdentifier(error.code)}${error.sessionID ? ` (${safeIdentifier(error.sessionID)})` : ""}`);
    }
  }
  lines.push(...renderFooter(options.help === true, color));

  const content = lines.join("\n");
  return options.previousLineCount === undefined
    ? content
    : renderInPlace(content, options.previousLineCount, options as AnsiOptions);
}

export const renderTUI = renderDashboard;
export const renderTerminalDashboard = renderDashboard;
