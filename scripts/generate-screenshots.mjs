#!/usr/bin/env node
// Run via `npm run screenshots` (builds first). Fixture-only: renders SVGs
// from synthetic records under a temp dir — never reads real user data and
// never bakes real homedir paths into committed assets.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createUsageWindows, createUsageRecord, toUsageTotals } from "../dist/src/domain/index.js";
import { renderDashboard, renderTable } from "../dist/src/output/index.js";

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/screenshots");
fs.mkdirSync(OUT_DIR, { recursive: true });

// Fixture project roots under a temp dir — committed SVGs must not leak a
// real username/homedir, and the generator must not depend on real checkouts.
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "oc2token-shots-"));
const FIXTURE_PROJECT_A = path.join(FIXTURE_ROOT, "OC2Token");
const FIXTURE_PROJECT_B = path.join(FIXTURE_ROOT, "opencode");
const FIXTURE_PROJECT_C = path.join(FIXTURE_ROOT, "client-app");

const NOW = new Date("2026-09-02T10:00:00.000Z");
const TZ = "Europe/Istanbul";

// Build a realistic unified snapshot without needing live service
function makeUnifiedFixture() {
  const windows = Object.values(createUsageWindows(NOW, TZ));

  // Helper to create record
  function rec({ provider, model, project, input, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0, createdAt }) {
    return createUsageRecord({
      sessionID: `${provider}-${project}-${String(createdAt.getTime()).slice(-4)}`.replaceAll("/", "-").replaceAll(" ", "-"),
      messageID: `msg-${provider}-${model.replaceAll("/", "-")}-${String(createdAt.getTime()).slice(-6)}`,
      createdAt,
      model,
      tokens: { input, output, reasoning, cacheRead, cacheWrite },
      observedAt: NOW,
      completeness: "final",
      provider,
      ...(project ? { project } : {}),
    });
  }

  const records = [
    // hour window: last 60 minutes (09:00-10:00 UTC = 12:00-13:00 Istanbul)
    rec({ provider: "opencode", model: "openai/gpt-5", project: FIXTURE_PROJECT_A, input: 4200, output: 1100, reasoning: 340, cacheRead: 800, cacheWrite: 120, createdAt: new Date("2026-09-02T09:55:00.000Z") }),
    rec({ provider: "opencode", model: "anthropic/claude-4-sonnet", project: FIXTURE_PROJECT_B, input: 3100, output: 900, reasoning: 210, cacheRead: 0, cacheWrite: 0, createdAt: new Date("2026-09-02T09:48:00.000Z") }),
    rec({ provider: "codex", model: "openai/gpt-5-codex", project: FIXTURE_PROJECT_A, input: 1800, output: 420, reasoning: 88, cacheRead: 150, cacheWrite: 30, createdAt: new Date("2026-09-02T09:42:00.000Z") }),
    rec({ provider: "antigravity", model: "google/gemini-3-pro", project: FIXTURE_PROJECT_C, input: 940, output: 210, reasoning: 44, cacheRead: 320, cacheWrite: 80, createdAt: new Date("2026-09-02T09:30:00.000Z") }),
    rec({ provider: "opencode", model: "openai/gpt-5-mini", project: FIXTURE_PROJECT_A, input: 520, output: 140, reasoning: 0, cacheRead: 60, cacheWrite: 10, createdAt: new Date("2026-09-02T09:15:00.000Z") }),

    // day window earlier today (00:00 Istanbul = 21:00 UTC previous day)
    rec({ provider: "opencode", model: "openai/gpt-5", project: FIXTURE_PROJECT_A, input: 8200, output: 2100, reasoning: 510, cacheRead: 1200, cacheWrite: 200, createdAt: new Date("2026-09-02T06:30:00.000Z") }),
    rec({ provider: "opencode", model: "anthropic/claude-4-sonnet", project: FIXTURE_PROJECT_B, input: 5400, output: 1600, reasoning: 380, cacheRead: 600, cacheWrite: 90, createdAt: new Date("2026-09-02T05:10:00.000Z") }),
    rec({ provider: "codex", model: "openai/gpt-5-codex", project: FIXTURE_PROJECT_A, input: 3200, output: 780, reasoning: 120, cacheRead: 280, cacheWrite: 40, createdAt: new Date("2026-09-02T04:00:00.000Z") }),
    rec({ provider: "antigravity", model: "google/gemini-3-flash", project: FIXTURE_PROJECT_C, input: 2100, output: 540, reasoning: 65, cacheRead: 410, cacheWrite: 70, createdAt: new Date("2026-09-02T02:30:00.000Z") }),
    rec({ provider: "opencode", model: "openai/gpt-4o", project: FIXTURE_PROJECT_A, input: 1600, output: 420, reasoning: 30, cacheRead: 220, cacheWrite: 15, createdAt: new Date("2026-09-01T22:15:00.000Z") }),

    // week window earlier this week
    rec({ provider: "opencode", model: "anthropic/claude-4-opus", project: FIXTURE_PROJECT_B, input: 12400, output: 3100, reasoning: 820, cacheRead: 1800, cacheWrite: 300, createdAt: new Date("2026-09-01T10:00:00.000Z") }),
    rec({ provider: "codex", model: "openai/gpt-5-codex", project: FIXTURE_PROJECT_A, input: 8800, output: 2100, reasoning: 410, cacheRead: 900, cacheWrite: 160, createdAt: new Date("2026-08-31T14:00:00.000Z") }),
    rec({ provider: "antigravity", model: "google/gemini-3-pro", project: FIXTURE_PROJECT_C, input: 5600, output: 1400, reasoning: 260, cacheRead: 740, cacheWrite: 120, createdAt: new Date("2026-08-30T09:00:00.000Z") }),
    rec({ provider: "opencode", model: "openai/gpt-5", project: FIXTURE_PROJECT_A, input: 4300, output: 1100, reasoning: 190, cacheRead: 540, cacheWrite: 80, createdAt: new Date("2026-08-29T16:00:00.000Z") }),
  ];

  // Compute window totals from records — needed because renderer reads totalsByWindow/totals, not derived totals
  function sum(records) {
    let input=0, output=0, reasoning=0, cacheRead=0, cacheWrite=0;
    for (const r of records) {
      input += r.input; output += r.output; reasoning += r.reasoning; cacheRead += r.cacheRead; cacheWrite += r.cacheWrite;
    }
    const rec = input+output+reasoning+cacheRead+cacheWrite;
    return { input, output, reasoning, cacheRead, cacheWrite, recorded_total: rec };
  }
  const windowMap = {};
  for (const w of windows) windowMap[w.kind] = w;
  function forWindow(kind) {
    const win = windowMap[kind];
    const filtered = records.filter(r => {
      const t = r.createdAt.getTime();
      return t >= win.from.getTime() && t < win.to.getTime();
    });
    return sum(filtered);
  }
  const totalsByWindow = {
    hour: forWindow("hour"),
    day: forWindow("day"),
    week: forWindow("week"),
  };
  // Also compute totalsByProvider etc would be derived, but we keep records for that
  return {
    capturedAt: NOW,
    windows,
    source: "unified",
    version: "0.1.1",
    records,
    totals: totalsByWindow,
    totalsByWindow,
    windowTotals: totalsByWindow,
    coverage: {
      complete: true,
      sessionsDiscovered: 14,
      sessionsScanned: 14,
      sessionsSkipped: 0,
      pagesRead: 22,
      jobsRetried: 0,
      provisionalMessages: 0,
      errors: [],
    },
    nextRefreshAt: new Date("2026-09-02T10:05:00.000Z"),
    lastUpdated: NOW,
    stale: false,
  };
}

function makeTrendsSnapshot() {
  // Provide explicit trends for nicer graph shape: simulate hourly distribution
  const base = makeUnifiedFixture();
  // Derive trend buckets manually is already done via records deriveTrends,
  // but we can override with smoother curve for visual.
  // We'll keep auto-derived and it will already look good.
  return base;
}

// ANSI color map — matching src/dashboard/render/ansi.ts
const PALETTE = {
  purple: "#af87ff",       // 141
  purpleDeep: "#875fff",   // 99
  purpleBright: "#d7afff", // 183
  purpleDim: "#8b7fa8",    // 103
  orange: "#ff8700",       // 208
  orangeBright: "#ffaf5f", // 214
  cyan: "#00d7ff",         // 36
  green: "#5faf5f",        // 32 approx #4ade80
  yellow: "#d7d700",
  red: "#ff5f5f",
  white: "#e6e2ff",
  muted: "#9a8fc2",
  dimWhite: "#cbd5e1",
};

const ANSI_TO_HEX = {
  "\u001b[38;5;141m": PALETTE.purple,
  "\u001b[38;5;99m": PALETTE.purpleDeep,
  "\u001b[38;5;183m": PALETTE.purpleBright,
  "\u001b[38;5;103m": PALETTE.purpleDim,
  "\u001b[38;5;208m": PALETTE.orange,
  "\u001b[38;5;214m": PALETTE.orangeBright,
  "\u001b[36m": PALETTE.cyan,
  "\u001b[32m": PALETTE.green,
  "\u001b[33m": PALETTE.yellow,
  "\u001b[31m": PALETTE.red,
  "\u001b[37m": PALETTE.white,
};

function parseAnsiLine(line) {
  // Strip hyperlink OSC 8 sequences: keep text, drop escapes
  // OSC 8 format: \u001b]8;;url\u0007 TEXT \u001b]8;;\u0007
  let stripped = line.replace(/\u001b\]8;;[^\u0007]*\u0007/g, "");
  // Also \u001b]8;;\u0007 closing already removed

  const segs = [];
  const regex = /\u001b\[([0-9;]*)m/g;
  let lastIdx = 0;
  let curColor = null;
  let curBold = false;
  let curUnderline = false;
  let match;
  while ((match = regex.exec(stripped)) !== null) {
    const start = match.index;
    if (start > lastIdx) {
      const text = stripped.slice(lastIdx, start);
      if (text) segs.push({ text, color: curColor, bold: curBold, underline: curUnderline });
    }
    const code = match[1] || "0";
    const parts = code.split(";");
    if (parts.includes("0")) {
      curColor = null;
      curBold = false;
      curUnderline = false;
    }
    if (parts.includes("1")) curBold = true;
    if (parts.includes("2")) {
      // dim — treat as muted
      curColor = PALETTE.purpleDim;
    }
    if (parts.includes("4")) curUnderline = true;
    if (parts.includes("24")) curUnderline = false;
    if (parts.includes("22")) curBold = false;
    // check for 38;5;N
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "38" && parts[i + 1] === "5" && parts[i + 2] !== undefined) {
        const n = parts[i + 2];
        const esc = `\u001b[38;5;${n}m`;
        if (ANSI_TO_HEX[esc]) curColor = ANSI_TO_HEX[esc];
        else curColor = PALETTE.white;
      }
      // Named colors fallback
      if (parts[i] === "36" && !code.includes("38")) curColor = PALETTE.cyan;
      if (parts[i] === "32" && !code.includes("38")) curColor = PALETTE.green;
      if (parts[i] === "33" && !code.includes("38")) curColor = PALETTE.yellow;
      if (parts[i] === "31" && !code.includes("38")) curColor = PALETTE.red;
      if (parts[i] === "34" && !code.includes("38")) curColor = "#5f87ff";
      if (parts[i] === "37" && !code.includes("38")) curColor = PALETTE.white;
    }

    lastIdx = regex.lastIndex;
  }
  if (lastIdx < stripped.length) {
    const text = stripped.slice(lastIdx);
    if (text) segs.push({ text, color: curColor, bold: curBold, underline: curUnderline });
  }
  // If no segments, return plain
  if (segs.length === 0 && stripped.length > 0) {
    // Should not happen because we sliced, but fallback
    segs.push({ text: stripped, color: null, bold: false, underline: false });
  }
  return segs;
}

function escapeXml(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function renderTextToSvg(text, opts = {}) {
  const {
    widthCols = 100,
    title = "oc2token — OpenCode 2 Token Usage",
    subtitle = "",
    showChrome = true,
  } = opts;

  // text is ANSI colored string from renderDashboard
  const lines = text.split("\n");
  // Remove trailing empty? Keep as is
  // For SVG sizing, count all lines including empties

  const fontSize = 12;
  const lineHeight = 16;
  const charWidth = 7.2; // for 12px monospace
  const paddingX = 18;
  const paddingY = 14;
  const chromeHeight = showChrome ? 34 : 0;

  const contentWidth = widthCols * charWidth;
  const contentHeight = lines.length * lineHeight;

  const outerPad = 16;
  const totalWidth = Math.ceil(contentWidth + paddingX * 2 + outerPad * 2);
  const totalHeight = Math.ceil(chromeHeight + contentHeight + paddingY * 2 + outerPad * 2 + (subtitle ? 0 : 0));

  const bg = "#0b0a14";
  const winBg = "#140f25";
  const termBg = "#15101f"; // slightly lighter than winBg but dark
  // Alternative palette: dark purple outer, window dark

  let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  svg += `<svg width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}" xmlns="http://www.w3.org/2000/svg" role="img">\n`;
  svg += `<defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000" flood-opacity="0.45"/></filter></defs>\n`;
  svg += `<rect width="${totalWidth}" height="${totalHeight}" rx="16" fill="${bg}"/>\n`;
  // Window frame
  svg += `<g filter="url(#shadow)">\n`;
  svg += `<rect x="${outerPad}" y="${outerPad}" width="${totalWidth - outerPad * 2}" height="${totalHeight - outerPad * 2}" rx="12" fill="${winBg}" stroke="#2a2045" stroke-opacity="0.9"/>\n`;
  if (showChrome) {
    svg += `<rect x="${outerPad}" y="${outerPad}" width="${totalWidth - outerPad * 2}" height="${chromeHeight}" rx="12" fill="#1e1633"/>\n`;
    // bottom edge of chrome to make only top rounded? overlay rect to mask bottom corners
    svg += `<rect x="${outerPad}" y="${outerPad + chromeHeight - 8}" width="${totalWidth - outerPad * 2}" height="8" fill="#1e1633"/>\n`;
    // traffic lights
    const cy = outerPad + chromeHeight / 2;
    svg += `<circle cx="${outerPad + 18}" cy="${cy}" r="6" fill="#ff5f56" stroke="#e0443e" stroke-width="0.5"/>\n`;
    svg += `<circle cx="${outerPad + 38}" cy="${cy}" r="6" fill="#ffbd2e" stroke="#dea123" stroke-width="0.5"/>\n`;
    svg += `<circle cx="${outerPad + 58}" cy="${cy}" r="6" fill="#27c93f" stroke="#1aab29" stroke-width="0.5"/>\n`;
    svg += `<text x="${totalWidth / 2}" y="${outerPad + 21}" text-anchor="middle" font-family="ui-sans-serif, -apple-system, system-ui, Helvetica, Arial" font-size="11.5" font-weight="500" fill="#a99dc5" letter-spacing="0.2">${escapeXml(title)}</text>\n`;
    // subtle line
    svg += `<line x1="${outerPad}" y1="${outerPad + chromeHeight}" x2="${totalWidth - outerPad}" y2="${outerPad + chromeHeight}" stroke="#2a2045" stroke-opacity="0.6"/>\n`;
  }
  // Terminal background inner
  const termX = outerPad + 8;
  const termY = outerPad + chromeHeight + 8;
  const termW = totalWidth - outerPad * 2 - 16;
  const termH = totalHeight - outerPad * 2 - chromeHeight - 16;
  svg += `<rect x="${termX}" y="${termY}" width="${termW}" height="${termH}" rx="8" fill="${termBg}"/>\n`;

  const textStartX = termX + paddingX;
  const textStartY = termY + paddingY + fontSize; // baseline of first line

  svg += `<text font-family="'SF Mono', 'Menlo', 'Monaco', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace" font-size="${fontSize}" line-height="${lineHeight}" xml:space="preserve">\n`;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const y = textStartY + i * lineHeight;
    // Empty line still need tspan placeholder
    if (line.length === 0) {
      svg += `<tspan x="${textStartX}" y="${y}" fill="${PALETTE.white}"> </tspan>\n`;
      continue;
    }
    const segs = parseAnsiLine(line);
    // If no ANSI, render whole line normal color
    if (segs.length === 0) {
      svg += `<tspan x="${textStartX}" y="${y}" fill="#d9d2f0">${escapeXml(line.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u001b\]8;;[^\u0007]*\u0007/g, ""))}</tspan>\n`;
      continue;
    }
    // First tspan needs x,y; subsequent share y but no x? Actually they continue after previous; use tspan without x,y to continue flowing
    let first = true;
    for (const seg of segs) {
      if (seg.text.length === 0) continue;
      const fill = seg.color ?? "#d9d2f0"; // default terminal fg
      const weight = seg.bold ? ' font-weight="700"' : "";
      const deco = seg.underline ? ' text-decoration="underline"' : "";
      const esc = escapeXml(seg.text);
      if (first) {
        svg += `<tspan x="${textStartX}" y="${y}" fill="${fill}"${weight}${deco}>${esc}</tspan>`;
        first = false;
      } else {
        svg += `<tspan fill="${fill}"${weight}${deco}>${esc}</tspan>`;
      }
    }
    svg += `\n`;
  }

  svg += `</text>\n`;
  svg += `</g>\n`;
  svg += `</svg>\n`;
  return svg;
}

function renderTableToSvg(text, widthCols = 80) {
  return renderTextToSvg(text, { widthCols, title: "oc2token --once --format table", showChrome: true });
}

async function main() {
  const fixture = makeTrendsSnapshot();

  // 1. Main dashboard — wide, day selected, no overlay
  const mainText = renderDashboard(fixture, {
    isTTY: true, ansi: true, color: true, width: 100, now: NOW, selectedWindow: "day",
  });
  const mainSvg = renderTextToSvg(mainText, { widthCols: 100, title: "oc2token — dashboard (day)" });
  fs.writeFileSync(path.join(OUT_DIR, "dashboard.svg"), mainSvg);
  console.log("wrote dashboard.svg", mainSvg.length);

  // 2. Settings overlay
  const settingsText = renderDashboard(fixture, {
    isTTY: true, ansi: true, color: true, width: 100, now: NOW, selectedWindow: "day",
    settings: { visible: true, enabledProviders: ["opencode", "codex", "antigravity"], refreshIntervalSeconds: 300, focusedIndex: 1 },
  });
  const settingsSvg = renderTextToSvg(settingsText, { widthCols: 100, title: "oc2token — settings (s)" });
  fs.writeFileSync(path.join(OUT_DIR, "dashboard-settings.svg"), settingsSvg);
  console.log("wrote dashboard-settings.svg", settingsSvg.length);

  // 3. Projects overlay
  const projectsText = renderDashboard(fixture, {
    isTTY: true, ansi: true, color: true, width: 100, now: NOW, selectedWindow: "day",
    projects: { visible: true },
  });
  const projectsSvg = renderTextToSvg(projectsText, { widthCols: 100, title: "oc2token — projects (p)" });
  fs.writeFileSync(path.join(OUT_DIR, "dashboard-projects.svg"), projectsSvg);
  console.log("wrote dashboard-projects.svg", projectsSvg.length);

  // 4. Help overlay
  const helpText = renderDashboard(fixture, {
    isTTY: true, ansi: true, color: true, width: 100, now: NOW, selectedWindow: "day", help: true,
  });
  const helpSvg = renderTextToSvg(helpText, { widthCols: 100, title: "oc2token — help (?)" });
  fs.writeFileSync(path.join(OUT_DIR, "dashboard-help.svg"), helpSvg);
  console.log("wrote dashboard-help.svg", helpSvg.length);

  // 5. Narrow layout (60 cols) — shows responsive stacking
  const narrowText = renderDashboard(fixture, {
    isTTY: true, ansi: true, color: true, width: 60, now: NOW, selectedWindow: "day",
  });
  const narrowSvg = renderTextToSvg(narrowText, { widthCols: 60, title: "oc2token — narrow (60 cols)" });
  fs.writeFileSync(path.join(OUT_DIR, "dashboard-narrow.svg"), narrowSvg);
  console.log("wrote dashboard-narrow.svg", narrowSvg.length);

  // 6. Hourly view focused
  const hourText = renderDashboard(fixture, {
    isTTY: true, ansi: true, color: true, width: 100, now: NOW, selectedWindow: "hour",
  });
  const hourSvg = renderTextToSvg(hourText, { widthCols: 100, title: "oc2token — hour view" });
  fs.writeFileSync(path.join(OUT_DIR, "dashboard-hour.svg"), hourSvg);
  console.log("wrote dashboard-hour.svg", hourSvg.length);

  // 7. Table output
  const tableText = renderTable(fixture);
  const tableSvg = renderTableToSvg(tableText, 100);
  fs.writeFileSync(path.join(OUT_DIR, "table.svg"), tableSvg);
  console.log("wrote table.svg", tableSvg.length);

  // 8. JSON snippet — use pretty JSON but render as code block SVG
  const { toJSONSnapshot } = await import("../dist/src/output/json.js");
  const json = toJSONSnapshot(fixture);
  const jsonPretty = JSON.stringify(json, null, 2).split("\n").slice(0, 28).join("\n") + "\n  ...";
  const jsonSvg = renderTextToSvg(jsonPretty, { widthCols: 84, title: "oc2token --json (schema v3)" });
  fs.writeFileSync(path.join(OUT_DIR, "json.svg"), jsonSvg);
  console.log("wrote json.svg", jsonSvg.length);

  // Generate PNG fallback? For now SVG only.

  // Also generate hero composed? For README we keep simple
  console.log("Done ->", OUT_DIR);
}

main().catch((e) => { console.error(e); process.exit(1); });
