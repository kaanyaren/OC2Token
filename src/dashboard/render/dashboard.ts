import type { UsageTotals, UsageWindowKind } from "../../domain/index.js";
import {
  ANSI,
  ansiEnabled,
  colorEnabled,
  emphasis,
  paint,
  renderInPlace,
  statusColor,
  type AnsiOptions,
  themeOrange,
  themePurple,
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

function panelHeading(
  title: string,
  width: number,
  color: boolean,
  accent: "purple" | "orange" = "purple",
): string {
  const label = truncate(title, Math.max(4, width - 6));
  const plainPrefix = `◆ ${label}`;
  const prefix = accent === "orange"
    ? themeOrange(plainPrefix, color, true)
    : themePurple(plainPrefix, color, true);
  const ruleLength = Math.max(2, width - lineWidth(plainPrefix) - 1);
  return `${prefix} ${themePurple("─".repeat(ruleLength), color)}`;
}

function cardLines(
  kind: UsageWindowKind,
  window: DashboardWindow,
  width: number,
  color: boolean,
  selected: boolean,
): string[] {
  const inner = Math.max(1, width - 2);
  const borderColor = selected ? ANSI.orange : ANSI.purpleDeep;
  const totalLabel = inner < 15 ? "Total" : "Recorded";
  const total = `${themePurple(totalLabel, color, true)}  ${themeOrange(formatTokenCount(window.totals.recorded_total), color, true)}`;
  const first = pad(total, inner);
  const components = formatTokenBreakdown(window.totals);
  const title = `${selected ? "▶" : "·"} ${cardTitle(kind)}`;
  const frame = (value: string): string => `│${pad(value, inner)}│`;
  const lines = [
    paint(border(width, "╭", "─", "╮"), borderColor, color),
    frame(selected
      ? themeOrange(truncate(title, inner), color, true)
      : themePurple(truncate(title, inner), color, true)),
    frame(first),
    frame(themePurple(truncate(components, inner), color)),
    frame(themeOrange(truncate(`Range ${safeLabel(window.window.label)}`, inner), color)),
    paint(border(width, "╰", "─", "╯"), borderColor, color),
  ];
  return lines;
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
  width: number,
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
  const compact = width < 70;
  const identity = width < 28
    ? `${themeOrange("◈", color, true)} ${emphasis(themePurple("OC2", color, true), color)} ${themePurple("// TOKENS", color)}`
    : `${themeOrange("◈", color, true)} ${emphasis(themePurple("OC2TOKEN", color, true), color)}  ${themePurple("// USAGE CONSOLE", color)}`;
  const title = compact ? "OC2Token Usage" : "OpenCode 2 Token Usage";
  const statusText = `Status: ${formatCoverage(snapshot.coverage, snapshot.stale)}`;
  return [
    identity,
    compact
      ? emphasis(themePurple(truncate(title, width), color, true), color)
      : `${emphasis(themePurple(title, color, true), color)}  ${themeOrange("·", color)} ${themePurple(source, color)}`,
    compact
      ? truncate(`Source: ${source} · Version: ${version}`, width)
      : `Source: ${source} · Version: ${version} · Range: ${safeLabel(selectedWindow.semantics)}`,
    compact
      ? truncate(`Window: ${safeLabel(selectedWindow.label)}`, width)
      : `Window: ${safeLabel(selectedWindow.label)} · ${formatWindowRange(selectedWindow.from, selectedWindow.to, timezone)}`,
    compact
      ? truncate(`Timezone: ${timezone} · ${next}`, width)
      : `Timezone: ${timezone} · Updated: ${updated} · ${next}`,
    compact
      ? statusColor(truncate(statusText, width), state, color)
      : `Status: ${status} · Coverage: ${formatCoverage(snapshot.coverage, snapshot.stale)}`,
    themePurple("─".repeat(Math.max(20, width)), color),
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
  if (trend.length === 0) return [panelHeading(title, width, color), "  No trend data recorded."];

  const max = Math.max(...trend.map((bucket) => bucket.totals.recorded_total), 0);
  if (max === 0) return [panelHeading(title, width, color), "  No trend data recorded."];

  const axisWidth = Math.max(4, formatTokenCount(max).length);
  const maxColumns = Math.max(8, Math.min(72, width - axisWidth - 5));
  const points = trend.length <= maxColumns
    ? trend.map((bucket) => ({ label: bucket.label, totals: bucket.totals }))
    : Array.from({ length: maxColumns }, (_, index) => {
        const start = Math.floor(index * trend.length / maxColumns);
        const end = Math.max(start + 1, Math.floor((index + 1) * trend.length / maxColumns));
        return {
          label: trend[start]?.label ?? "",
          totals: trend.slice(start, end).reduce(sumTrendTotals, zeroTotals()),
        };
      });
  const graphWidth = Math.max(1, points.length);
  const levels = 5;
  return [
    panelHeading(title, width, color),
    ...Array.from({ length: levels }, (_, row) => {
      const level = levels - row;
      const cells = points.map((point) => {
        const filled = point.totals.recorded_total > 0 && point.totals.recorded_total / max >= level / levels;
        return filled ? themeOrange("█", color, true) : themePurple("·", color);
      }).join("");
      const label = level === levels || level === 1
        ? formatTokenCount(Math.round(max * level / levels)).padStart(axisWidth)
        : " ".repeat(axisWidth);
      return `${label} ${themePurple("│", color)} ${cells}`;
    }),
    `${" ".repeat(axisWidth)} ${themePurple(`└${"─".repeat(graphWidth)}`, color)}`,
    `${" ".repeat(axisWidth + 2)}${themePurple(graphLabels(points, graphWidth), color)}`,
  ];
}

function zeroTotals(): UsageTotals {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, recorded_total: 0 };
}

function sumTrendTotals(left: UsageTotals, right: { readonly totals: UsageTotals }): UsageTotals {
  return {
    input: left.input + right.totals.input,
    output: left.output + right.totals.output,
    reasoning: left.reasoning + right.totals.reasoning,
    cacheRead: left.cacheRead + right.totals.cacheRead,
    cacheWrite: left.cacheWrite + right.totals.cacheWrite,
    recorded_total: left.recorded_total + right.totals.recorded_total,
  };
}

function graphLabels(
  points: ReadonlyArray<{ readonly label: string }>,
  width: number,
): string {
  if (points.length === 0) return "";
  const labelWidth = Math.max(3, Math.min(7, Math.floor(width / 3)));
  const labels = points.length < 12
    ? [{ index: 0, value: points[0]?.label ?? "" }, { index: points.length - 1, value: points.at(-1)?.label ?? "" }]
    : [
        { index: 0, value: points[0]?.label ?? "" },
        { index: Math.floor(points.length / 2), value: points[Math.floor(points.length / 2)]?.label ?? "" },
        { index: points.length - 1, value: points.at(-1)?.label ?? "" },
      ];
  const characters = Array.from({ length: width }, () => " ");
  for (const entry of labels) {
    const value = truncate(entry.value, labelWidth);
    const position = entry.index === points.length - 1
      ? Math.max(0, width - value.length)
      : Math.min(width - value.length, Math.round(entry.index / Math.max(1, points.length - 1) * (width - value.length)));
    for (const [offset, character] of [...value].entries()) {
      if (position + offset < characters.length) characters[position + offset] = character;
    }
  }
  return characters.join("").trimEnd();
}

function renderBreakdown(
  title: string,
  values: ReadonlyArray<BreakdownTotal>,
  color: boolean,
  width: number,
  accent: "purple" | "orange",
): string[] {
  const lines = [panelHeading(title, width, color, accent)];
  if (values.length === 0) {
    return [...lines, width < 32 ? "  (none)" : "  No breakdown data recorded."];
  }
  const visible = values.slice(0, 12);
  const nameWidth = Math.max(8, Math.min(42, Math.floor(width * 0.42)));
  const detailsWidth = Math.max(4, width - nameWidth - 13);
  const details = width < 70 ? "" : `  ${themePurple("COMPONENTS", color)}`;
  lines.push(`  ${themePurple("NAME".padEnd(nameWidth), color, true)} ${themeOrange("RECORDED".padStart(8), color, true)}${details}`);
  for (const item of visible) {
    const name = item.provider ? `${safeIdentifier(item.provider)}/${safeIdentifier(item.name)}` : safeIdentifier(item.name);
    const componentDetails = width < 70
      ? ""
      : `  ${themePurple(truncate(formatTokenBreakdown(item.totals), detailsWidth), color)}`;
    lines.push(`  ${themePurple(truncate(name, nameWidth).padEnd(nameWidth), color)} ${themeOrange(formatTokenCount(item.totals.recorded_total).padStart(8), color)}${componentDetails}`);
  }
  if (values.length > visible.length) {
    lines.push(`  +${values.length - visible.length} more`);
  }
  return lines;
}

function renderFooter(help: boolean, color: boolean, width: number): string[] {
  const key = (value: string): string => themeOrange(value, color, true);
  if (help) {
    if (width < 50) {
      return [
        "",
        panelHeading("Help", width, color, "orange"),
        ` ${key("r")} refresh  ${key("1/2/3")} periods`,
        ` ${key("q")} quit  ${key("?")} close`,
      ];
    }
    if (width < 70) {
      return [
        "",
        panelHeading("Help", width, color, "orange"),
        ` ${key("r/R")} Refresh   ${key("1/2/3")} Periods`,
        ` ${key("q")} Quit   ${key("?")} Toggle help`,
      ];
    }
    return [
      "",
      panelHeading("Help", width, color, "orange"),
      `  ${key("r/R")} Refresh now   ${key("1")} Hour   ${key("2")} Today   ${key("3")} Week   ${key("Tab/Arrows")} Navigate`,
      `  ${key("q")} Quit             ${key("?")} Toggle help`,
    ];
  }
  if (width < 50) {
    return [` ${key("r")} ${key("1/2/3")} ${key("q")} ${key("?")}`];
  }
  if (width < 70) {
    return [` ${key("r")} Refresh   ${key("1/2/3")} Periods   ${key("q")} Quit   ${key("?")} Help`];
  }
  return [
    "",
    ` ${key("r")} Refresh   ${key("1")} Hour   ${key("2")} Today   ${key("3")} Week   ${key("Tab/Arrows")} Navigate   ${key("q")} Quit   ${key("?")} Help`,
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
  const lines = renderHeader(snapshot, options, color, width);
  const cardWidth = width >= WIDE_LAYOUT_MIN_WIDTH
    ? Math.max(CARD_MIN_WIDTH, Math.floor((width - 4) / 3))
    : Math.max(12, Math.min(CARD_MIN_WIDTH, width - 2));
  const cards = allWindowKinds().map((kind) => cardLines(
    kind,
    snapshot.windows[kind],
    cardWidth,
    color,
    selected === kind,
  ));

  if (width >= WIDE_LAYOUT_MIN_WIDTH && cards.length === 3) {
    lines.push(...composeCards(cards));
  } else {
    for (const card of cards) lines.push(...card, "");
  }

  lines.push("");
  lines.push(...renderTrend(snapshot, selected, color, width));
  lines.push("");
  const selectedWindow = snapshot.windows[selected];
  lines.push(...renderBreakdown(`Models · ${cardTitle(selected)}`, selectedWindow.models, color, width, "purple"));
  lines.push(...renderBreakdown(`Providers · ${cardTitle(selected)}`, selectedWindow.providers, color, width, "orange"));
  if (snapshot.coverage.errors.length > 0) {
    lines.push("");
    lines.push(emphasis("Coverage errors", color));
    for (const error of snapshot.coverage.errors.slice(0, 5)) {
      lines.push(`  ${safeIdentifier(error.code)}${error.sessionID ? ` (${safeIdentifier(error.sessionID)})` : ""}`);
    }
  }
  lines.push(...renderFooter(options.help === true, color, width));

  const content = lines.join("\n");
  return options.previousLineCount === undefined
    ? content
    : renderInPlace(content, options.previousLineCount, options as AnsiOptions);
}

export const renderTUI = renderDashboard;
export const renderTerminalDashboard = renderDashboard;
