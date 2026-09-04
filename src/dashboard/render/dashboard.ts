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
  themeCache,
  themeCacheUnderline,
  themeCost,
  themeCyan,
  themeIn,
  themeInUnderline,
  themeOrange,
  themeOut,
  themeOutUnderline,
  themePurple,
  themeWhite,
  zebraRow,
} from "./ansi.js";
import {
  coverageState,
  DASHBOARD_ROW_CAP,
  formatCoverage,
  formatCost,
  formatStatusFooter,
  formatTokenBreakdown,
  formatTokenCount,
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
import { ALL_PROVIDER_KINDS } from "../settings/index.js";

const CARD_MIN_WIDTH = 27;
const WIDE_LAYOUT_MIN_WIDTH = 90;
export const APP_PADDING = 2;
export const GITHUB_URL = "https://github.com/kaanyaren/OC2Token";
// ANSI/OSC sequences are intentionally matched here so outer padding can
// truncate styled lines by visible width without removing their escapes.
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/y;

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

function truncateExact(value: string, width: number): string {
  // Like truncate but preserves multiple spaces — for trusted breakdown strings
  // where "    " spacing must not be collapsed to " ".
  const len = [...value].length;
  if (len <= width) return value;
  return [...value].slice(0, Math.max(0, width - 1)).join("") + "…";
}

/** Truncate visible terminal width without stripping ANSI styling. */
function truncateVisible(value: string, width: number): string {
  if (lineWidth(value) <= width) return value;
  const target = Math.max(0, width - 1);
  let result = "";
  let index = 0;
  let visible = 0;
  while (index < value.length && visible < target) {
    if (value[index] === "\u001b") {
      ANSI_SEQUENCE.lastIndex = index;
      const escape = ANSI_SEQUENCE.exec(value);
      if (escape?.index === index) {
        result += escape[0];
        index += escape[0].length;
        continue;
      }
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    result += character;
    index += character.length;
    visible += 1;
  }
  return `${result}…${value.includes("\u001b") ? ANSI.reset : ""}`;
}

function colorizeBreakdown(value: string, enabled: boolean, underline = false): string {
  if (!enabled || value.length === 0) return value;
  // Breakdown arrives as gap-separated tokens like "IN 100    OUT 20    CACHE 0".
  // truncateExact can cut the string mid-token ("IN 100    OU…"), so color each
  // segment from its label to the next multi-space gap (or end of string).
  // Alternatives are longest-first with a trailing-letter guard so truncated
  // fragments ("OU", "CAC") still match without false positives inside words.
  // Legacy short forms ("I", "In", …) are kept as fallbacks.
  const specs: Array<{ labels: string[]; fn: (segment: string, on: boolean) => string }> = [
    { labels: ["IN", "In", "I"], fn: underline ? themeInUnderline : themeIn },
    { labels: ["OUT", "Out", "OU", "O"], fn: underline ? themeOutUnderline : themeOut },
    { labels: ["CACHE", "Cache", "CACH", "CAC", "CA", "C"], fn: underline ? themeCacheUnderline : themeCache },
  ];
  let result = value;
  for (const spec of specs) {
    const match = new RegExp(`\\b(?:${spec.labels.join("|")})(?![A-Za-z])`).exec(result);
    if (!match || match.index === undefined) continue;
    const start = match.index;
    const tail = result.slice(start);
    const gap = tail.search(/\s{2,}/);
    const end = gap === -1 ? result.length : start + gap;
    result = result.slice(0, start) + spec.fn(result.slice(start, end), enabled) + result.slice(end);
  }
  return result;
}

function border(width: number, left: string, fill: string, right: string): string {
  return left + fill.repeat(Math.max(0, width - 2)) + right;
}

function cardTitle(kind: UsageWindowKind): string {
  return kind === "hour" ? "LAST 60 MINUTES" : kind === "day" ? "TODAY" : kind === "week" ? "THIS WEEK" : "LAST MONTH";
}

function panelHeading(
  title: string,
  width: number,
  color: boolean,
  accent: "purple" | "orange" | "cyan" = "purple",
): string {
  const label = truncate(title, Math.max(4, width - 6));
  const plainPrefix = `◆ ${label}`;
  const prefix =
    accent === "orange"
      ? themeOrange(plainPrefix, color, true)
      : accent === "cyan"
        ? themeCyan(plainPrefix, color, true)
        : themePurple(plainPrefix, color, true);
  const ruleLength = Math.max(2, width - lineWidth(plainPrefix) - 1);
  return `${prefix} ${themePurple("─".repeat(ruleLength), color)}`;
}

function providerAccent(name: string, color: boolean, bright = false): (value: string) => string {
  const key = String(name).toLowerCase();
  if (key === "codex") return (value: string) => themeOrange(value, color, bright);
  if (key === "antigravity") return (value: string) => themeCyan(value, color, bright);
  return (value: string) => themePurple(value, color, bright);
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
  const rawComponents = formatTokenBreakdown(window.totals);
  // Preserve the 4-space gaps ("    ") — truncate() would collapse them via safeLabel.
  // Adaptively fall back to 2 spaces when the 4-space layout doesn't fit.
  let displayComponents = rawComponents;
  if (lineWidth(rawComponents) > inner) {
    const fallback = rawComponents.replaceAll("    ", "  ");
    if (lineWidth(fallback) <= inner) displayComponents = fallback;
    else displayComponents = truncateExact(rawComponents, inner);
  }
  const title = `${selected ? "▶" : "·"} ${cardTitle(kind)}`;
  const frame = (value: string): string => `│${pad(value, inner)}│`;
  const costLabel = inner < 15 ? "Cost" : "Est. cost";
  const costValue = formatCost(window.cost);
  const costLine = `${themePurple(costLabel, color, true)}  ${themeCost(costValue, color)}`;
  const lines = [
    paint(border(width, "╭", "─", "╮"), borderColor, color),
    frame(emphasis(themeWhite(truncate(title, inner), color, true), color)),
    frame(first),
    frame(colorizeBreakdown(truncateExact(displayComponents, inner), color, true)),
    frame(pad(costLine, inner)),
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

const HEADER_LINES = 3;
const CARD_LINES = 6;
const CARD_GAP = 2;
const FOUR_CARD_LAYOUT_MIN_WIDTH = CARD_MIN_WIDTH * 4 + CARD_GAP * 3;

export interface CardHitRegion {
  readonly kind: UsageWindowKind;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export function getCardHitRegions(width: number): ReadonlyArray<CardHitRegion> {
  const clamped = Math.max(20, width);
  const contentWidth = Math.max(1, clamped - APP_PADDING * 2);
  const headerHeight = HEADER_LINES;
  if (contentWidth >= FOUR_CARD_LAYOUT_MIN_WIDTH) {
    const cardWidth = Math.max(CARD_MIN_WIDTH, Math.floor((contentWidth - CARD_GAP * 3) / 4));
    const y1 = headerHeight + 1;
    const y2 = y1 + CARD_LINES - 1;
    return allWindowKinds().map((kind, idx) => {
      const x1 = APP_PADDING + idx * (cardWidth + CARD_GAP) + 1;
      const x2 = x1 + cardWidth - 1;
      return { kind, x1, y1, x2, y2 };
    });
  }
  if (contentWidth >= WIDE_LAYOUT_MIN_WIDTH) {
    const cardWidth = Math.max(CARD_MIN_WIDTH, Math.floor((contentWidth - CARD_GAP) / 2));
    const yGap = 0; // stacked rows touch — no blank separator (see renderDashboard)
    return allWindowKinds().map((kind, idx) => {
      const column = idx % 2;
      const row = Math.floor(idx / 2);
      const x1 = APP_PADDING + column * (cardWidth + CARD_GAP) + 1;
      const y1 = headerHeight + 1 + row * (CARD_LINES + yGap);
      return { kind, x1, y1, x2: x1 + cardWidth - 1, y2: y1 + CARD_LINES - 1 };
    });
  }
  const cardWidth = Math.max(12, Math.min(CARD_MIN_WIDTH, contentWidth - 2));
  const yGap = 0; // stacked cards touch — no blank separator (see renderDashboard)
  return allWindowKinds().map((kind, idx) => {
    const y1 = headerHeight + 1 + idx * (CARD_LINES + yGap);
    const y2 = y1 + CARD_LINES - 1;
    const x1 = APP_PADDING + 1;
    const x2 = x1 + cardWidth - 1;
    return { kind, x1, y1, x2, y2 };
  });
}

function renderHeader(color: boolean, width: number): string[] {
  const compact = width < 70;
  const identity = width < 28
    ? `${themeOrange("◈", color, true)} ${emphasis(themePurple("OC2", color, true), color)} ${themePurple("// TOKENS", color)}`
    : `${themeOrange("◈", color, true)} ${emphasis(themePurple("OC2TOKEN", color, true), color)}  ${themePurple("// USAGE CONSOLE", color)}`;
  const title = compact ? "OC2Token Usage" : "OpenCode 2 Token Usage";
  // No trailing blank line: the top cards start directly under the rule to
  // keep vertical spacing tight (HEADER_LINES must match this length).
  return [
    identity,
    emphasis(themePurple(truncate(title, width), color, true), color),
    themePurple("─".repeat(width), color),
  ];
}

/**
 * Single canonical TTY status footer. Uses the shared formatStatusFooter
 * helper (`Status: <STATE · sessions…>` once) — do not duplicate the coverage
 * string as `Status: X · Coverage: X`. Colored by coverageState, centered
 * horizontally inside a box. Truncated to preserve redraw geometry.
 */
function renderStatusBox(
  snapshot: ReturnType<typeof normalizeDashboardSnapshot>,
  color: boolean,
  width: number,
): string[] {
  const state = coverageState(snapshot.coverage, snapshot.stale);
  const maxContent = Math.max(1, width - 4);
  const plain = truncate(formatStatusFooter(snapshot.coverage, snapshot.stale), maxContent);
  const contentLen = [...plain].length;
  const boxWidth = Math.min(width, contentLen + 4);
  const leftPad = Math.max(0, Math.floor((width - boxWidth) / 2));
  const prefix = " ".repeat(leftPad);
  const colored = statusColor(plain, state, color);
  return [
    prefix + paint(border(boxWidth, "╭", "─", "╮"), ANSI.purpleDeep, color),
    prefix + paint("│", ANSI.purpleDeep, color) + ` ${colored} ` + paint("│", ANSI.purpleDeep, color),
    prefix + paint(border(boxWidth, "╰", "─", "╯"), ANSI.purpleDeep, color),
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
  if (trend.length === 0) return [panelHeading(title, width, color), truncate("  No trend data recorded.", width)];

  const max = Math.max(...trend.map((bucket) => bucket.totals.recorded_total), 0);
  if (max === 0) return [panelHeading(title, width, color), truncate("  No trend data recorded.", width)];

  const graphWidth = Math.max(8, width - 4);
  const points =
    trend.length <= graphWidth
      ? Array.from({ length: graphWidth }, (_, index) => {
          const sourceIndex = Math.floor(index * trend.length / graphWidth);
          const bucket = trend[sourceIndex]!;
          return { label: bucket.label, totals: bucket.totals };
        })
      : Array.from({ length: graphWidth }, (_, index) => {
          const start = Math.floor(index * trend.length / graphWidth);
          const end = Math.max(start + 1, Math.floor((index + 1) * trend.length / graphWidth));
          return {
            label: trend[start]?.label ?? "",
            totals: trend.slice(start, end).reduce(sumTrendTotals, zeroTotals()),
          };
        });
  const levels = 5;
  return [
    panelHeading(title, width, color),
    ...Array.from({ length: levels }, (_, row) => {
      const level = levels - row;
      const cells = points.map((point) => {
        const filled = point.totals.recorded_total > 0 && point.totals.recorded_total / max >= level / levels;
        return filled ? themeOrange("█", color, true) : themePurple("·", color);
      }).join("");
      return `  ${cells}`;
    }),
    `  ${themePurple("─".repeat(graphWidth), color)}`,
    `  ${themePurple(graphLabels(points, graphWidth), color)}`,
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

interface BreakdownColumnWidths {
  readonly recorded: number;
  readonly input: number;
  readonly output: number;
  readonly cache: number;
  readonly cost: number;
}

function breakdownColumnWidths(values: ReadonlyArray<BreakdownTotal>): BreakdownColumnWidths {
  const recorded = values.map((item) => formatTokenCount(item.totals.recorded_total));
  const input = values.map((item) => formatTokenCount(item.totals.input));
  const output = values.map((item) => formatTokenCount(item.totals.output + item.totals.reasoning));
  const cache = values.map((item) => formatTokenCount(item.totals.cacheRead + item.totals.cacheWrite));
  const cost = values.map((item) => formatCost(item.cost));
  return {
    recorded: Math.max("RECORDED".length, ...recorded.map((value) => [...value].length)),
    input: Math.max("In".length, ...input.map((value) => [...value].length)),
    output: Math.max("Out".length, ...output.map((value) => [...value].length)),
    cache: Math.max("Cache".length, ...cache.map((value) => [...value].length)),
    cost: Math.max("Cost".length, ...cost.map((value) => [...value].length)),
  };
}

function renderBreakdown(
  title: string,
  values: ReadonlyArray<BreakdownTotal>,
  color: boolean,
  width: number,
  accent: "purple" | "orange" | "cyan",
  columnWidths: BreakdownColumnWidths,
): string[] {
  // Token columns intentionally merge sub-components for TTY width:
  // Out = output + reasoning, Cache = cacheRead + cacheWrite (same as
  // formatTokenBreakdown and the table view). Raw splits remain available in
  // stable JSON (UsageTotals keeps all five components separately).
  // Row cap is DASHBOARD_ROW_CAP (12) for TTY height; the piped table uses
  // TABLE_ROW_CAP (20) for logs. Different caps are intentional — dashboard
  // prioritizes fitting without scroll, table prioritizes completeness.
  const lines = [panelHeading(title, width, color, accent)];
  if (values.length === 0) {
    return [...lines, width < 32 ? "  (none)" : "  No breakdown data recorded."];
  }
  const visible = values.slice(0, DASHBOARD_ROW_CAP);
  const isProvider = title.toLowerCase().includes("provider");
  const showTokenDetails = width >= 70;
  const showCost = width >= 32;
  // Keep the complete numeric block against the right edge of the terminal.
  // The name column gets the remaining space instead of using a fixed 42%
  // width, which previously left all numeric columns beside the names.
  const numericWidth = columnWidths.recorded
    + (showTokenDetails ? columnWidths.input + columnWidths.output + columnWidths.cache : 0)
    + (showCost ? columnWidths.cost : 0);
  const separatorWidth = showTokenDetails ? 9 : showCost ? 5 : 3;
  const nameWidth = Math.max(1, width - numericWidth - separatorWidth);
  // Table-aligned In/Out/Cache/Cost columns: header already shows labels, rows show only numbers.
  // Header uses same column widths so values line up vertically (right-aligned numbers).
  const headerIn = themeIn("In".padStart(columnWidths.input), color);
  const headerOut = themeOut("Out".padStart(columnWidths.output), color);
  const headerCache = themeCache("Cache".padStart(columnWidths.cache), color);
  const headerCost = themeCost("Cost".padStart(columnWidths.cost), color);
  const details = showTokenDetails
    ? showCost
      ? `  ${headerIn} ${headerOut} ${headerCache}  ${headerCost}`
      : `  ${headerIn} ${headerOut} ${headerCache}`
    : showCost
      ? `  ${headerCost}`
      : "";
  lines.push(`  ${themePurple("NAME".padEnd(nameWidth), color, true)} ${themeOrange("RECORDED".padStart(columnWidths.recorded), color, true)}${details}`);
  for (const [rowIndex, item] of visible.entries()) {
    const safeProv = item.provider ? safeIdentifier(item.provider) : "";
    const safeNm = safeIdentifier(item.name);
    const rawName = safeProv && safeProv !== safeNm ? `${safeProv}/${safeNm}` : safeNm;
    const safeName = truncate(rawName, nameWidth);
    const countText = formatTokenCount(item.totals.recorded_total).padStart(columnWidths.recorded);
    const inPlain = formatTokenCount(item.totals.input);
    const outPlain = formatTokenCount(item.totals.output + item.totals.reasoning);
    const cachePlain = formatTokenCount(item.totals.cacheRead + item.totals.cacheWrite);
    const costPlain = formatCost(item.cost);
    const inCol = themeIn(inPlain.padStart(columnWidths.input), color);
    const outCol = themeOut(outPlain.padStart(columnWidths.output), color);
    const cacheCol = themeCache(cachePlain.padStart(columnWidths.cache), color);
    const costCol = themeCost(costPlain.padStart(columnWidths.cost), color);
    const componentDetails = showTokenDetails
      ? showCost
        ? `  ${inCol} ${outCol} ${cacheCol}  ${costCol}`
        : `  ${inCol} ${outCol} ${cacheCol}`
      : showCost
        ? `  ${costCol}`
        : "";
    if (isProvider) {
      const accentForRow = providerAccent(item.name, color, true);
      const countColored = accentForRow(countText);
      // Keep provider name in its accent but retain table alignment for token columns.
      const nameColored = accentForRow(safeName.padEnd(nameWidth));
      lines.push(zebraRow(`  ${nameColored} ${countColored}${componentDetails}`, rowIndex % 2 === 1, color));
    } else {
      lines.push(zebraRow(
        `  ${themeWhite(safeName.padEnd(nameWidth), color)} ${themeOrange(countText, color)}${componentDetails}`,
        rowIndex % 2 === 1,
        color,
      ));
    }
  }
  if (values.length > visible.length) {
    lines.push(`  +${values.length - visible.length} more`);
  }
  return lines;
}

function formatRefreshInterval(seconds: number): string {
  const clamped = Math.max(60, Math.min(14400, Math.floor(seconds)));
  if (clamped % 3600 === 0) {
    const h = clamped / 3600;
    return `${h}h`;
  }
  if (clamped >= 3600) {
    const h = Math.floor(clamped / 3600);
    const m = Math.floor((clamped % 3600) / 60);
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }
  if (clamped % 60 === 0) {
    return `${clamped / 60}m`;
  }
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

/** Refresh interval presets (seconds). Shared by the settings panel and mouse clicks. */
export const REFRESH_PRESETS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 14400] as const;

function renderSettingsPanel(
  settings: NonNullable<DashboardRenderOptions["settings"]>,
  width: number,
  color: boolean,
): string[] {
  function presetIndex(value: number): number {
    const clamped = Math.max(60, Math.min(14400, Math.floor(value)));
    let best = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < REFRESH_PRESETS.length; i += 1) {
      const diff = Math.abs(REFRESH_PRESETS[i]! - clamped);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    return best;
  }

  const panelWidth = Math.min(width, Math.min(Math.max(38, width - 4), 58));
  const inner = Math.max(1, panelWidth - 2);
  const leftPad = Math.max(0, Math.floor((width - panelWidth) / 2));
  const padPrefix = " ".repeat(leftPad);
  const providers: readonly string[] = [...ALL_PROVIDER_KINDS];
  const intervalStr = formatRefreshInterval(settings.refreshIntervalSeconds);
  const presetIdx = presetIndex(settings.refreshIntervalSeconds);
  const pct = presetIdx / (REFRESH_PRESETS.length - 1);

  const lines: string[] = [];
  lines.push(padPrefix + paint(border(panelWidth, "╭", "─", "╮"), ANSI.purpleDeep, color));

  // Title
  const titlePlain = "◆ Settings";
  const hintPlain = "· s / esc to close";
  const titleAvail = Math.max(6, inner);
  // Truncate plain parts separately to keep colors
  const hintAvail = Math.max(1, inner - titlePlain.length - 2);
  const titleTrunc = truncate(titlePlain, Math.min(titlePlain.length, inner));
  const hintTrunc = truncate(hintPlain, hintAvail);
  const titleLine = `${themeOrange(titleTrunc, color, true)}  ${themePurple(hintTrunc, color)}`;
  lines.push(padPrefix + `│${pad(titleLine, inner)}│`);
  lines.push(padPrefix + `│${" ".repeat(inner)}│`);

  // Providers heading
  const providersHeading = truncate("Providers  —  space to toggle", inner);
  lines.push(padPrefix + `│${pad(themePurple(providersHeading, color, true), inner)}│`);

  for (let i = 0; i < providers.length; i += 1) {
    const name = providers[i]!;
    const enabled = settings.enabledProviders.includes(name);
    const focused = settings.focusedIndex === i;
    const checkbox = enabled ? "◉" : "○";
    const prefix = focused ? themeOrange("▶ ", color, true) : "  ";
    const checkColored = enabled ? themeOrange(checkbox, color, true) : themePurple(checkbox, color);
    const accent = providerAccent(name, color, true);
    const suffix = focused ? "  ← toggle" : "";
    const suffixLen = focused ? 10 : 0; // "  ← toggle" visible length
    const nameAvail = Math.max(4, inner - 4 - suffixLen);
    const nameTrunc = truncate(name, nameAvail);
    const nameColored = enabled ? accent(nameTrunc) : themePurple(nameTrunc, color);
    const lineContent = `${prefix}${checkColored} ${nameColored}`;
    const full = focused ? `${lineContent}${themeOrange(suffix, color)}` : lineContent;
    lines.push(padPrefix + `│${pad(full, inner)}│`);
  }

  lines.push(padPrefix + `│${" ".repeat(inner)}│`);

  // Breakdown tables heading (focused indices 3-4; interval moves to 5)
  const tablesHeading = truncate("Tables  —  space to toggle", inner);
  lines.push(padPrefix + `│${pad(themePurple(tablesHeading, color, true), inner)}│`);

  const tableRows: ReadonlyArray<{ readonly label: string; readonly shown: boolean; readonly index: number }> = [
    { label: "Providers table", shown: settings.showProvidersTable !== false, index: 3 },
    { label: "Projects table", shown: settings.showProjectsTable !== false, index: 4 },
  ];
  for (const row of tableRows) {
    const focused = settings.focusedIndex === row.index;
    const checkbox = row.shown ? "◉" : "○";
    const prefix = focused ? themeOrange("▶ ", color, true) : "  ";
    const checkColored = row.shown ? themeOrange(checkbox, color, true) : themePurple(checkbox, color);
    const suffix = focused ? "  ← toggle" : "";
    const suffixLen = focused ? 10 : 0; // "  ← toggle" visible length
    const nameAvail = Math.max(4, inner - 4 - suffixLen);
    const nameTrunc = truncate(row.label, nameAvail);
    const nameColored = row.shown ? themeWhite(nameTrunc, color, true) : themePurple(nameTrunc, color);
    const lineContent = `${prefix}${checkColored} ${nameColored}`;
    const full = focused ? `${lineContent}${themeOrange(suffix, color)}` : lineContent;
    lines.push(padPrefix + `│${pad(full, inner)}│`);
  }

  lines.push(padPrefix + `│${" ".repeat(inner)}│`);

  // Refresh interval heading with value
  const intervalFocused = settings.focusedIndex === 5;
  const intervalHeadingPlain = "Refresh interval";
  const headingAvail = Math.max(6, inner - intervalStr.length - 5 - (intervalFocused ? 2 : 0));
  const headingTrunc = truncate(intervalHeadingPlain, headingAvail);
  const headingColored = intervalFocused
    ? themeOrange(`▶ ${headingTrunc}`, color, true)
    : themePurple(headingTrunc, color, true);
  const headingWithValue = `${headingColored} ${themePurple("·", color)} ${themeOrange(intervalStr, color, true)}`;
  lines.push(padPrefix + `│${pad(headingWithValue, inner)}│`);

  // Slider track
  const leftLabel = "1m";
  const rightLabel = "4h";
  const trackAvail = Math.max(8, inner - leftLabel.length - rightLabel.length - 6);
  const trackLen = Math.max(8, Math.min(26, trackAvail));
  const handlePos = Math.round(pct * (trackLen - 1));
  const ticks = new Set<number>();
  for (let i = 0; i < REFRESH_PRESETS.length; i += 1) {
    ticks.add(Math.round((i / (REFRESH_PRESETS.length - 1)) * (trackLen - 1)));
  }
  const trackChars: string[] = Array.from({ length: trackLen }, (_, idx) => {
    if (idx === handlePos) return "●";
    if (ticks.has(idx)) return "·";
    return "─";
  });
  const trackStr = trackChars
    .map((ch, idx) => {
      if (idx === handlePos) return intervalFocused ? themeOrange(ch, color, true) : themePurple(ch, color, true);
      if (ch === "·") return themePurple(ch, color);
      if (idx < handlePos) return themeOrange(ch, color);
      return themePurple(ch, color);
    })
    .join("");
  const sliderCore = `${themePurple(leftLabel, color)} ${trackStr} ${themePurple(rightLabel, color)}`;
  // Center slider within inner
  const sliderVisibleLen = leftLabel.length + 1 + trackLen + 1 + rightLabel.length;
  const sliderLeftPad = Math.max(1, Math.floor((inner - sliderVisibleLen) / 2));
  const sliderLine = `${" ".repeat(sliderLeftPad)}${sliderCore}`;
  lines.push(padPrefix + `│${pad(sliderLine, inner)}│`);

  // Preset scale / hint
  if (inner >= 44) {
    const presetLabels = REFRESH_PRESETS.map((v) => formatRefreshInterval(v));
    const scale = presetLabels
      .map((label, idx) => (idx === presetIdx ? themeOrange(label, color, true) : themePurple(label, color)))
      .join(themePurple(" · ", color));
    const scaleTrunc = truncate(scale, inner);
    // If truncated, scale may have stripped colors; re-apply? Keep simple: truncate plain then recolor? But scale already colored; truncate will strip.
    // Instead build plain scale and compare: if scale visible length > inner, fall back to compact hint.
    const plainScaleLen = presetLabels.join(" · ").length;
    if (plainScaleLen + 2 <= inner) {
      lines.push(padPrefix + `│${pad(`  ${scale}`, inner)}│`);
    } else {
      // Fallback compact: show current value centered
      const valLine = themeOrange(intervalStr, color, true);
      const padVal = Math.max(0, Math.floor((inner - intervalStr.length) / 2));
      lines.push(padPrefix + `│${pad(`${" ".repeat(padVal)}${valLine}`, inner)}│`);
    }
  } else {
    const compact = intervalFocused ? "← → to adjust" : "← 1m  ·  4h →";
    const hint = intervalFocused ? themeOrange(compact, color, true) : themePurple(compact, color);
    const hintPad = Math.max(0, Math.floor((inner - stripAnsi(compact).length) / 2));
    lines.push(padPrefix + `│${pad(`${" ".repeat(hintPad)}${hint}`, inner)}│`);
  }

  lines.push(padPrefix + `│${" ".repeat(inner)}│`);
  const navHint = "↑↓ navigate  •  space toggle  •  ←→ adjust";
  const closeHint = "s / esc close  •  r refresh";
  lines.push(padPrefix + `│${pad(themePurple(truncate(navHint, inner), color), inner)}│`);
  lines.push(padPrefix + `│${pad(themePurple(truncate(closeHint, inner), color), inner)}│`);
  lines.push(padPrefix + paint(border(panelWidth, "╰", "─", "╯"), ANSI.purpleDeep, color));
  return lines;
}

function renderProjectsPanel(
  snapshot: ReturnType<typeof normalizeDashboardSnapshot>,
  selected: UsageWindowKind,
  width: number,
  color: boolean,
): string[] {
  const windowProjects = snapshot.windows[selected]?.projects ?? [];
  const globalProjects = snapshot.projects;
  const projects = windowProjects.length > 0 ? windowProjects : globalProjects;
  const panelWidth = Math.min(width, Math.min(Math.max(42, width - 6), 76));
  const inner = Math.max(1, panelWidth - 2);
  const leftPad = Math.max(0, Math.floor((width - panelWidth) / 2));
  const padPrefix = " ".repeat(leftPad);
  const titleKind = selected === "hour" ? "Last 60 Minutes" : selected === "day" ? "Today" : selected === "week" ? "This Week" : "Last Month";
  const totalForWindow = snapshot.windows[selected]?.totals.recorded_total ?? 0;

  const lines: string[] = [];
  lines.push(padPrefix + paint(border(panelWidth, "╭", "─", "╮"), ANSI.purpleDeep, color));
  const titlePlain = `◆ Projects · ${titleKind}`;
  const hintPlain = "· p / esc to close";
  const titleAvail = Math.max(8, inner - hintPlain.length - 1);
  const titleTrunc = truncate(titlePlain, titleAvail);
  const hintTrunc = truncate(hintPlain, Math.max(1, inner - titleTrunc.length - 1));
  const titleLine = `${themeOrange(titleTrunc, color, true)} ${themePurple(hintTrunc, color)}`;
  lines.push(padPrefix + `│${pad(titleLine, inner)}│`);
  lines.push(padPrefix + `│${" ".repeat(inner)}│`);

  if (projects.length === 0) {
    const emptyMsg = truncate("No project data recorded for this period.", inner - 2);
    lines.push(padPrefix + `│${pad(`  ${themePurple(emptyMsg, color)}`, inner)}│`);
    lines.push(padPrefix + `│${pad(themePurple(truncate("Projects are derived from session directories.", inner - 2), color), inner)}│`);
    lines.push(padPrefix + `│${" ".repeat(inner)}│`);
    lines.push(padPrefix + `│${pad(themePurple(truncate("Tip: run a session in a project folder and refresh.", inner), color), inner)}│`);
  } else {
    const visible = projects.slice(0, 10);
    const showCost = inner >= 50;
    let costWidth = 0;
    let headerCost = "";
    if (showCost) {
      const costStrs = visible.map((entry) => formatCost(entry.cost));
      const winCostStr = formatCost(snapshot.windows[selected]?.cost);
      const allCostStrs = [...costStrs, winCostStr];
      costWidth = Math.max("Cost".length, ...allCostStrs.map((s) => [...s].length));
      headerCost = themeCost("Cost".padStart(costWidth), color);
    }
    // Header row
    const nameWidth = Math.max(12, Math.min(36, Math.floor(inner * 0.52)));
    const headerName = themePurple("PROJECT".padEnd(nameWidth), color, true);
    const headerRecorded = themeOrange("RECORDED".padStart(9), color, true);
    const headerPct = themePurple("%".padStart(4), color);
    const header = showCost
      ? `  ${headerName} ${headerRecorded} ${headerPct} ${headerCost}`
      : `  ${headerName} ${headerRecorded} ${headerPct}`;
    lines.push(padPrefix + `│${pad(header, inner)}│`);
    const separator = showCost
      ? `  ${themePurple("─".repeat(nameWidth), color)} ${themePurple("─".repeat(9), color)} ${themePurple("─".repeat(4), color)} ${themePurple("─".repeat(costWidth), color)}`
      : `  ${themePurple("─".repeat(nameWidth), color)} ${themePurple("─".repeat(9), color)} ${themePurple("─".repeat(4), color)}`;
    lines.push(padPrefix + `│${pad(separator, inner)}│`);
    for (const entry of visible) {
      const pct = totalForWindow > 0 ? Math.round((entry.totals.recorded_total / totalForWindow) * 100) : 0;
      const count = formatTokenCount(entry.totals.recorded_total).padStart(9);
      const pctStr = `${pct}%`.padStart(4);
      // Derive short name: basename if absolute path, otherwise full
      let display = entry.name;
      if (display.includes("/") && display.length > nameWidth) {
        const parts = display.split("/").filter((p) => p.length > 0);
        const base = parts.at(-1) ?? display;
        const oneUp = parts.length >= 2 ? `${parts.at(-2)}/${base}` : base;
        if (oneUp.length <= nameWidth) display = oneUp;
        else display = base;
      }
      const safe = truncate(display, nameWidth);
      const nameColored = themeCyan(safe.padEnd(nameWidth), color, true);
      const countColored = themeOrange(count, color, true);
      const pctColored = themePurple(pctStr, color);
      if (showCost) {
        const costColored = themeCost(formatCost(entry.cost).padStart(costWidth), color);
        lines.push(padPrefix + `│${pad(`  ${nameColored} ${countColored} ${pctColored} ${costColored}`, inner)}│`);
      } else {
        lines.push(padPrefix + `│${pad(`  ${nameColored} ${countColored} ${pctColored}`, inner)}│`);
      }
      // Second line with breakdown In/Out/Cache for that project under narrow? Only if inner wide
      if (inner >= 50) {
        const breakdown = formatTokenBreakdown(entry.totals);
        if (showCost) {
          const costStr = formatCost(entry.cost);
          const availForBreakdown = Math.max(1, inner - 4 - 2 - [...costStr].length);
          const breakdownTrunc = truncate(breakdown, availForBreakdown);
          const coloredBreakdown = colorizeBreakdown(breakdownTrunc, color);
          const coloredCost = themeCost(costStr, color);
          const combined = `${coloredBreakdown}  ${coloredCost}`;
          lines.push(padPrefix + `│${pad(`    ${combined}`, inner)}│`);
        } else {
          const breakdownTrunc = truncate(breakdown, inner - 4);
          const coloredBreakdown = colorizeBreakdown(breakdownTrunc, color);
          lines.push(padPrefix + `│${pad(`    ${themePurple(coloredBreakdown, color)}`, inner)}│`);
        }
      }
    }
    if (projects.length > visible.length) {
      const more = truncate(`+${projects.length - visible.length} more projects`, inner - 2);
      lines.push(padPrefix + `│${pad(`  ${themePurple(more, color)}`, inner)}│`);
    }
    lines.push(padPrefix + `│${" ".repeat(inner)}│`);
    const windowCostStr = formatCost(snapshot.windows[selected]?.cost);
    const totalLine = showCost
      ? `Total projects: ${projects.length}  ·  Period total: ${formatTokenCount(totalForWindow)}  ·  Period cost: ${windowCostStr}`
      : `Total projects: ${projects.length}  ·  Period total: ${formatTokenCount(totalForWindow)}`;
    lines.push(padPrefix + `│${pad(themePurple(truncate(totalLine, inner), color), inner)}│`);
  }

  lines.push(padPrefix + `│${" ".repeat(inner)}│`);
  lines.push(padPrefix + `│${pad(themePurple(truncate("p / esc to close  •  1/2/3/4 switch period", inner), color), inner)}│`);
  lines.push(padPrefix + paint(border(panelWidth, "╰", "─", "╯"), ANSI.purpleDeep, color));
  return lines;
}

function renderCredit(width: number, color: boolean): string {
  const repo = GITHUB_URL;
  const full = `Kaan Yaren · ${repo}`;
  const plain = width < 45 ? "Kaan Yaren" : full;
  const truncated = truncate(plain, width);
  // Use hyperlink OSC 8 when color/ansi enabled — still counts as plain text for width checks (stripAnsi removes it)
  const link = colorEnabled({ isTTY: true, ansi: true, color })
    ? `\u001b]8;;https://github.com/kaanyaren/OC2Token\u0007${truncated}\u001b]8;;\u0007`
    : truncated;
  const colored = paint(link, ANSI.purpleDim, color) as string;
  // Center within width
  const visibleLen = lineWidth(truncated);
  const left = Math.max(0, Math.floor((width - visibleLen) / 2));
  // stripAnsi for final length check: left pad + truncated length <= width (when color false)
  // When color true, link still has OSC 8 but stripAnsi removes it, so same.
  return `${" ".repeat(left)}${colored}`;
}

function renderFooter(help: boolean, color: boolean, width: number): string[] {
  const key = (value: string): string => themeOrange(value, color, true);
  if (help) {
    if (width < 50) {
      return [
        "",
        panelHeading("Help", width, color, "orange"),
        ` ${key("r")} refresh  ${key("1/2/3/4")} periods ${key("p")} projects`,
        ` ${key("q")} quit  ${key("?")} close`,
      ];
    }
    if (width < 70) {
      return [
        "",
        panelHeading("Help", width, color, "orange"),
        ` ${key("r/R")} Refresh   ${key("1/2/3/4")} Periods  ${key("p")} Projects`,
        ` ${key("q")} Quit   ${key("?")} Toggle help   ${key("s")} Settings`,
      ];
    }
    return [
      "",
      panelHeading("Help", width, color, "orange"),
      `  ${key("r/R")} Refresh now   ${key("1")} Hour   ${key("2")} Today   ${key("3")} Week   ${key("4")} Month   ${key("Tab/Arrows")} Navigate`,
      `  ${key("p")} Projects   ${key("s")} Settings   ${key("q")} Quit   ${key("?")} Toggle help`,
    ];
  }
  if (width < 50) {
    return [` ${key("r")} ${key("1/2/3/4")} ${key("p")} ${key("s")} ${key("q")} ${key("?")}`];
  }
  if (width < 70) {
    // Keep footer under 50 chars so width=50 still truncates correctly
    if (width < 60) {
      return [` ${key("r")} Refresh  ${key("1/2/3/4")} ${key("p")} Proj ${key("s")} ${key("q")} Quit ${key("?")} Help`];
    }
    return [` ${key("r")} Refresh  ${key("1/2/3/4")} Periods  ${key("p")} Proj ${key("s")} ${key("q")} Quit ${key("?")} Help`];
  }
  if (width < 78) {
    return [` ${key("r")} ${key("1")} Hour  ${key("2")} Today  ${key("3")} Week  ${key("4")} Month  ${key("p")} ${key("s")} ${key("q")} ${key("?")}`];
  }
  if (width < 90) {
    return [` ${key("r")} ${key("1")} Hour  ${key("2")} Today  ${key("3")} Week  ${key("4")} Month  ${key("p")} Proj  ${key("s")} Settings  ${key("q")} Quit  ${key("?")} Help`];
  }
  if (width < 120) {
    return [
      ` ${key("r")} Refresh  ${key("1")} Hour  ${key("2")} Today  ${key("3")} Week  ${key("4")} Month  ${key("p")} Projects  ${key("s")} Settings  ${key("q")} Quit  ${key("?")} Help`,
    ];
  }
  return [
    "",
    ` ${key("r")} Refresh   ${key("1")} Hour   ${key("2")} Today   ${key("3")} Week   ${key("4")} Month   ${key("Tab/Arrows")} Navigate   ${key("p")} Projects   ${key("s")} Settings   ${key("q")} Quit   ${key("?")} Help`,
  ];
}

/** Dashboard action triggered by clicking a footer token. */
export type FooterClickAction =
  | "refresh"
  | "hour"
  | "day"
  | "week"
  | "month"
  | "projects"
  | "settings"
  | "quit"
  | "help";

/**
 * Map a footer token (whitespace-delimited word under the cursor) to its
 * dashboard action. Returns undefined for decorative tokens ("Periods",
 * "Navigate", "1/2/3/4", …). Pure helper for mouse click handling.
 */
export function footerClickAction(token: string): FooterClickAction | undefined {
  switch (token) {
    case "r":
    case "Refresh":
      return "refresh";
    case "1":
    case "Hour":
      return "hour";
    case "2":
    case "Today":
      return "day";
    case "3":
    case "Week":
      return "week";
    case "4":
    case "Month":
      return "month";
    case "p":
    case "Proj":
    case "Projects":
      return "projects";
    case "s":
    case "Settings":
      return "settings";
    case "q":
    case "Quit":
      return "quit";
    case "?":
    case "Help":
      return "help";
    default:
      return undefined;
  }
}

/**
 * Find the whitespace-delimited token under 1-based column `cx` in an
 * already ANSI-stripped line. Returns undefined when the column is blank.
 */
export function footerTokenAtX(line: string, cx: number): string | undefined {
  const re = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    const start = match.index + 1;
    if (cx >= start && cx < start + match[0].length) return match[0];
  }
  return undefined;
}

export function renderDashboard(
  input: DashboardSnapshotInput,
  options: DashboardRenderOptions = {},
): string {
  const snapshot = normalizeDashboardSnapshot(input);
  // Reserve two columns on each side for a consistent application gutter.
  // Content is rendered at the inner width so borders, tables, and overlays
  // all share the same outer padding without relying on terminal wrapping.
  const terminalWidth = Math.max(20, options.width ?? 100);
  const width = Math.max(1, terminalWidth - APP_PADDING * 2);
  const color = colorEnabled(options);
  const selected = options.selectedWindow ?? "day";
  const lines = renderHeader(color, width);
  const cardWidth = width >= FOUR_CARD_LAYOUT_MIN_WIDTH
    ? Math.max(CARD_MIN_WIDTH, Math.floor((width - CARD_GAP * 3) / 4))
    : width >= WIDE_LAYOUT_MIN_WIDTH
      ? Math.max(CARD_MIN_WIDTH, Math.floor((width - CARD_GAP) / 2))
      : Math.max(12, Math.min(CARD_MIN_WIDTH, width - 2));
  const cards = allWindowKinds().map((kind) => cardLines(
    kind,
    snapshot.windows[kind],
    cardWidth,
    color,
    selected === kind,
  ));

  if (width >= FOUR_CARD_LAYOUT_MIN_WIDTH) {
    lines.push(...composeCards(cards));
  } else if (width >= WIDE_LAYOUT_MIN_WIDTH) {
    for (let index = 0; index < cards.length; index += 2) {
      lines.push(...composeCards(cards.slice(index, index + 2)));
    }
  } else {
    for (const card of cards) lines.push(...card);
  }

  lines.push("");
  lines.push(...renderTrend(snapshot, selected, color, width));
  lines.push("");
  const selectedWindow = snapshot.windows[selected];
  const breakdownWidths = breakdownColumnWidths([
    ...selectedWindow.models,
    ...selectedWindow.providers,
    ...selectedWindow.projects,
  ]);
  lines.push(...renderBreakdown(`Models · ${cardTitle(selected)}`, selectedWindow.models, color, width, "purple", breakdownWidths));
  if (options.settings?.showProvidersTable !== false) {
    lines.push(...renderBreakdown(`Providers · ${cardTitle(selected)}`, selectedWindow.providers, color, width, "orange", breakdownWidths));
  }
  if (options.settings?.showProjectsTable !== false) {
    lines.push(...renderBreakdown(`Projects · ${cardTitle(selected)}`, selectedWindow.projects, color, width, "cyan", breakdownWidths));
  }
  if (snapshot.coverage.errors.length > 0) {
    lines.push("");
    lines.push(emphasis("Coverage errors", color));
    for (const error of snapshot.coverage.errors.slice(0, 5)) {
      const message = (error as { message?: string }).message;
      const label = message ? safeLabel(message) : safeIdentifier(error.code);
      lines.push(`  ${label}${error.sessionID ? ` (${safeIdentifier(error.sessionID)})` : ""}`);
    }
  }
  lines.push(...renderStatusBox(snapshot, color, width));
  lines.push(...renderFooter(options.help === true, color, width));

  if (options.settings?.visible === true) {
    lines.push("");
    lines.push(...renderSettingsPanel(options.settings, width, color));
  }

  if (options.projects?.visible === true) {
    lines.push("");
    lines.push(...renderProjectsPanel(snapshot, selected, width, color));
  }

  lines.push("");
  lines.push(renderCredit(width, color));

  const outerPadding = " ".repeat(APP_PADDING);
  const content = lines
    .map((line) => `${outerPadding}${pad(truncateVisible(line, width), width)}${outerPadding}`)
    .join("\n");
  return options.previousLineCount === undefined
    ? content
    : renderInPlace(content, options.previousLineCount, options as AnsiOptions);
}

export const renderTUI = renderDashboard;
export const renderTerminalDashboard = renderDashboard;
