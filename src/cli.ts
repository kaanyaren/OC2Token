#!/usr/bin/env node

import process from "node:process";
import { basename } from "node:path";
import { createRequire } from "node:module";

import {
  ANSI,
  createStableRedraw,
  getCardHitRegions,
  renderDashboard,
  renderJSON,
  renderTable,
  type DashboardSnapshotInput,
} from "./output/index.js";
import {
  createApplicationSource,
  emptyCollectionResult,
  newCollectionRequest,
  readCachedSnapshot,
  type ApplicationOptions,
} from "./application.js";
import { RefreshCoordinator } from "./dashboard/state/index.js";
import {
  createUsageWindows,
  isProviderKind,
  type ProviderKind,
  type UsageWindowKind,
} from "./domain/index.js";
import { runOpenCodeDoctor } from "./opencode/index.js";
import { runCodexDoctor } from "./codex/doctor.js";
import { runAntigravityDoctor } from "./antigravity/doctor.js";
import {
  ALL_PROVIDER_KINDS,
  SETTINGS_DEFAULT_REFRESH_SECONDS,
  SETTINGS_MAX_REFRESH_SECONDS,
  SETTINGS_MIN_REFRESH_SECONDS,
  adjustRefreshIntervalByPreset,
  clampRefreshIntervalSeconds,
  loadDashboardSettings,
  saveDashboardSettings,
  type DashboardSettings,
} from "./dashboard/settings/index.js";

/**
 * CLI version is read from package.json (not hardcoded) so `--version` and
 * `--help` cannot drift. Falls back to "0.1.2" when the manifest is
 * unreachable (e.g. unusual bundling). Tries both src (`../package.json`)
 * and dist (`../../package.json`) layouts.
 */
function resolveCliVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    for (const candidate of ["../package.json", "../../package.json"]) {
      try {
        const pkg = require(candidate) as { version?: unknown };
        if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
      } catch {
        // Try the next candidate layout.
      }
    }
  } catch {
    // createRequire itself failed — fall through to the fallback below.
  }
  return "0.1.2";
}

const VERSION = resolveCliVersion();
/**
 * Error envelope version. Distinct from stable snapshot `schemaVersion: 4`
 * (see src/output/json.ts JSON_SCHEMA_VERSION): error payloads use
 * `errorSchemaVersion` so parsers never confuse an error for data.
 */
const ERROR_SCHEMA_VERSION = 1 as const;
const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

interface CliOptions {
  readonly period: UsageWindowKind;
  readonly once: boolean;
  readonly json: boolean;
  readonly format: "auto" | "dashboard" | "table" | "json";
  readonly refreshIntervalSeconds: number;
  readonly timezone: string;
  readonly project?: string;
  readonly cacheDirectory?: string;
  readonly color: boolean;
  readonly command?: "doctor";
  readonly filterProviders: Set<ProviderKind>;
  readonly refreshExplicit: boolean;
  readonly filterExplicit: boolean;
}

interface CliIO {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
}

function usage(): string {
  return `oc2token ${VERSION}

Usage:
  oc2token [hour|day|week]
  oc2token [options]
  oc2token doctor [--source <provider>] [--json]

Options:
  --once                 Collect once and exit
  --json                 Emit stable JSON and exit
  --format <mode>        auto, dashboard, table, or json
  --refresh <seconds>    Auto-refresh cadence; 0 is manual-only, or 60-14400 (1m-4h).
                       With 0 the settings panel shows persisted value or 300s
                       default while auto-refresh stays off.
  --timezone <IANA>      Time zone for local day and ISO week boundaries
  --project <id>         Restrict collection to an OpenCode project
  --cache-dir <path>     Override the normalized metadata cache directory
  --source <provider>    Filter providers: opencode, codex, antigravity, or all (repeatable)
  --no-color             Disable ANSI colors
  -h, --help             Show this help
  -v, --version          Show the version

Dashboard keys: r refresh, 1/2/3 / click top card to select period, p projects, s settings, ? help, q quit.
`;
}

function failUsage(message: string): never {
  throw new Error(`${message}\n\n${usage()}`);
}

function parseSeconds(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(seconds)) {
    failUsage("--refresh must be a non-negative integer number of seconds");
  }
  return seconds;
}

function parseArgs(args: readonly string[]): CliOptions | "help" | "version" {
  let period: UsageWindowKind = "day";
  let once = false;
  let json = false;
  let format: CliOptions["format"] = "auto";
  let refreshIntervalSeconds = 300;
  let refreshExplicit = false;
  let filterExplicit = false;
  let timezone = DEFAULT_TIMEZONE;
  let project: string | undefined;
  let cacheDirectory: string | undefined;
  let color = true;
  let command: CliOptions["command"];
  let periodSeen = false;
  const filterProviders = new Set<ProviderKind>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") return "help";
    if (arg === "-v" || arg === "--version") return "version";
    if (arg === "--once") { once = true; continue; }
    if (arg === "--json") { json = true; once = true; format = "json"; continue; }
    if (arg === "--no-color") { color = false; continue; }
    if (arg === "--source") {
      filterExplicit = true;
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) failUsage("--source requires a value");
      if (value === "all") {
        filterProviders.clear();
        continue;
      }
      if (!isProviderKind(value)) {
        failUsage(`Unknown source: ${value} (expected opencode, codex, antigravity, or all)`);
      }
      filterProviders.add(value as ProviderKind);
      continue;
    }
    if (arg === "--refresh" || arg === "--timezone" || arg === "--project" || arg === "--cache-dir" || arg === "--format") {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) failUsage(`${arg} requires a value`);
      if (arg === "--refresh") { refreshIntervalSeconds = parseSeconds(value); refreshExplicit = true; }
      else if (arg === "--timezone") timezone = value;
      else if (arg === "--project") project = value;
      else if (arg === "--cache-dir") cacheDirectory = value;
      else {
        if (value !== "auto" && value !== "dashboard" && value !== "table" && value !== "json") {
          failUsage(`Unknown output format: ${value}`);
        }
        format = value;
      }
      continue;
    }
    if (arg === "doctor") {
      if (command !== undefined) failUsage("Only one command can be selected");
      command = "doctor";
      continue;
    }
    if (arg === "hour" || arg === "day" || arg === "week") {
      if (periodSeen) failUsage("Only one period can be selected");
      period = arg;
      periodSeen = true;
      continue;
    }
    if (arg.startsWith("-")) failUsage(`Unknown option: ${arg}`);
    failUsage(`Unexpected argument: ${arg}`);
  }

  if (command !== undefined) {
    if (periodSeen || format === "dashboard") failUsage("doctor cannot be combined with a period or dashboard output");
    once = true;
  }
  if (format === "json") once = true;
  if (refreshExplicit && refreshIntervalSeconds !== 0 && (refreshIntervalSeconds < SETTINGS_MIN_REFRESH_SECONDS || refreshIntervalSeconds > SETTINGS_MAX_REFRESH_SECONDS)) {
    failUsage(`--refresh must be 0 (manual) or between ${SETTINGS_MIN_REFRESH_SECONDS} and ${SETTINGS_MAX_REFRESH_SECONDS} seconds (1 minute to 4 hours)`);
  }
  return { period, once, json, format, refreshIntervalSeconds, refreshExplicit, filterExplicit, timezone, project, cacheDirectory, color, command, filterProviders };
}

function emptyTotals() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, recorded_total: 0 };
}

function dashboardInput(
  state: ReturnType<RefreshCoordinator["getState"]>,
  fallback: ReturnType<typeof emptyCollectionResult>,
  wallNow: Date,
  monotonicNow: number,
): DashboardSnapshotInput {
  const result = state.snapshot ?? state.lastGoodSnapshot ?? fallback;
  const coverageErrors = [...result.coverage.errors];
  if (state.status === "error" && state.lastError !== undefined) {
    coverageErrors.push({
      code: "unknown",
      message: state.lastError instanceof Error ? state.lastError.message : String(state.lastError),
      retryable: true,
    });
  }
  const nextRefreshAt = state.nextRefreshAt === undefined
    ? null
    : new Date(wallNow.getTime() + state.nextRefreshAt - monotonicNow);
  return {
    ...result,
    stale: state.stale,
    lastUpdated: state.lastUpdated ?? result.capturedAt,
    nextRefreshAt,
    coverage: { ...result.coverage, errors: coverageErrors },
  };
}

function writeError(io: CliIO, error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    // Error contract: { errorSchemaVersion: 1, error: { code, message } }.
    // Deliberately NOT `schemaVersion` — that field means stable data (v4).
    io.stdout.write(`${JSON.stringify({ errorSchemaVersion: ERROR_SCHEMA_VERSION, error: { code: "oc2token", message } })}\n`);
  } else {
    io.stderr.write(`oc2token: ${message}\n`);
  }
}

/** Debug-only stderr logging for swallowed runtime errors (applySettings etc.). */
function debugWarn(io: CliIO, context: string, error: unknown): void {
  if (process.env.OC2TOKEN_DEBUG === undefined && process.env.DEBUG?.includes("oc2token") !== true) return;
  io.stderr.write(`oc2token [debug] ${context}: ${error instanceof Error ? error.message : String(error)}\n`);
}

function requestedJSON(args: readonly string[]): boolean {
  return args.some((arg, index) => arg === "--json" || (arg === "--format" && args[index + 1] === "json"));
}

async function runDoctor(options: CliOptions, io: CliIO): Promise<number> {
  const shouldCheck = (provider: ProviderKind): boolean =>
    options.filterProviders.size === 0 || options.filterProviders.has(provider);

  const checks: Array<{ readonly name: ProviderKind; readonly ok: boolean; readonly message: string }> = [];
  let endpoint: string | undefined;
  let version: string | undefined;
  let fingerprint: string | undefined;

  const tasks: Array<Promise<void>> = [];

  if (shouldCheck("opencode")) {
    tasks.push((async () => {
      const report = await runOpenCodeDoctor({
        ensure: false,
        ...(options.project === undefined ? {} : { project: options.project }),
      });
      const ok = report.ok;
      const message = report.checks.map((check) => check.message).join("; ") || (ok ? "OpenCode 2 service OK" : "OpenCode 2 service unavailable");
      checks.push({ name: "opencode", ok, message });
      if (report.endpoint) endpoint = report.endpoint;
      if (report.version) version = report.version;
      if (report.fingerprint) fingerprint = report.fingerprint;
      // If opencode failed, still keep check; overall ok derived later.
    })());
  }

  if (shouldCheck("codex")) {
    tasks.push((async () => {
      const check = await runCodexDoctor();
      checks.push(check);
    })());
  }

  if (shouldCheck("antigravity")) {
    tasks.push((async () => {
      const check = await runAntigravityDoctor();
      checks.push(check);
    })());
  }

  await Promise.all(tasks);

  // Deterministic order: opencode, codex, antigravity
  const order: Record<ProviderKind, number> = { opencode: 0, codex: 1, antigravity: 2 };
  checks.sort((a, b) => order[a.name] - order[b.name]);

  const ok = checks.length > 0 ? checks.every((check) => check.ok) : false;

  const report = {
    ok,
    checks,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(version === undefined ? {} : { version }),
    ...(fingerprint === undefined ? {} : { fingerprint }),
  };

  if (options.json || options.format === "json") {
    io.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    io.stdout.write(`oc2token doctor: ${report.ok ? "OK" : "FAILED"}\n`);
    for (const check of report.checks) io.stdout.write(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.message}\n`);
    if (report.endpoint) io.stdout.write(`Endpoint: ${report.endpoint}\n`);
    if (report.version) io.stdout.write(`Version: ${report.version}\n`);
  }
  return report.ok ? 0 : 1;
}

async function runOnce(options: CliOptions, io: CliIO): Promise<number> {
  const now = new Date();
  const applicationOptions: ApplicationOptions = {
    ...(options.cacheDirectory === undefined ? {} : { cacheDirectory: options.cacheDirectory }),
    ...(options.filterProviders.size === 0 ? {} : { filterProviders: options.filterProviders }),
  };
  const { source } = createApplicationSource(applicationOptions);
  const request = newCollectionRequest(now, options.timezone, {
    ...(options.project === undefined ? {} : { project: options.project }),
  });
  const result = await source.collect(request);
  const format = options.json ? "json" : options.format === "auto" ? "table" : options.format;
  if (format === "json") io.stdout.write(`${renderJSON(result, false)}\n`);
  else if (format === "table") io.stdout.write(`${renderTable(result)}\n`);
  else io.stdout.write(`${renderDashboard(result, { isTTY: false, color: options.color, selectedWindow: options.period })}\n`);
  return result.coverage.complete ? 0 : 3;
}

/**
 * Single clamp policy for refresh intervals. 0 is manual-only (scheduler
 * disabled, no auto timer) and is never clamped; every other value is
 * clamped to 60..14400 (1 minute to 4 hours). The settings panel cannot
 * represent manual mode, so when the scheduler is 0 the panel shows the
 * persisted value or the 300s default while auto-refresh stays off.
 */
function resolveInitialRefreshIntervals(
  explicitSeconds: number | undefined,
  persisted: DashboardSettings | undefined,
  fallbackSeconds: number,
): { schedulerInterval: number; settingsInterval: number } {
  if (explicitSeconds !== undefined) {
    if (explicitSeconds === 0) {
      return {
        schedulerInterval: 0,
        settingsInterval: persisted !== undefined
          ? clampRefreshIntervalSeconds(persisted.refreshIntervalSeconds)
          : SETTINGS_DEFAULT_REFRESH_SECONDS,
      };
    }
    const clamped = clampRefreshIntervalSeconds(explicitSeconds);
    return { schedulerInterval: clamped, settingsInterval: clamped };
  }
  if (persisted !== undefined) {
    const clamped = clampRefreshIntervalSeconds(persisted.refreshIntervalSeconds);
    return { schedulerInterval: clamped, settingsInterval: clamped };
  }
  if (fallbackSeconds === 0) {
    return { schedulerInterval: 0, settingsInterval: SETTINGS_DEFAULT_REFRESH_SECONDS };
  }
  const clamped = clampRefreshIntervalSeconds(fallbackSeconds);
  return { schedulerInterval: clamped, settingsInterval: clamped };
}

async function runDashboard(options: CliOptions, io: CliIO): Promise<number> {
  if (!io.stdout.isTTY || !io.stdin.isTTY) {
    return runOnce({ ...options, once: true }, io);
  }

  // A corrupt/future cache is intentionally ignored; it is an optimization,
  // while the live service remains the only accounting authority.
  const cached = await readCachedSnapshot(options.cacheDirectory);

  // Load persisted settings and merge with CLI options. CLI explicit flags win.
  const persisted = await loadDashboardSettings(options.cacheDirectory);
  const ALL_KINDS: readonly ProviderKind[] = ALL_PROVIDER_KINDS;

  let initialSettingsEnabled: ProviderKind[];
  if (options.filterExplicit) {
    initialSettingsEnabled = options.filterProviders.size === 0 ? [...ALL_KINDS] : [...options.filterProviders];
  } else if (persisted !== undefined) {
    initialSettingsEnabled = [...persisted.enabledProviders] as ProviderKind[];
  } else {
    initialSettingsEnabled = options.filterProviders.size === 0 ? [...ALL_KINDS] : [...options.filterProviders];
  }

  // Normalize to valid kinds and ensure non-empty (at least one)
  initialSettingsEnabled = initialSettingsEnabled.filter((k): k is ProviderKind => ALL_KINDS.includes(k as ProviderKind));
  if (initialSettingsEnabled.length === 0) initialSettingsEnabled = [...ALL_KINDS];

  const { schedulerInterval: initialSchedulerInterval, settingsInterval: initialSettingsInterval } =
    resolveInitialRefreshIntervals(
      options.refreshExplicit ? options.refreshIntervalSeconds : undefined,
      persisted,
      options.refreshIntervalSeconds,
    );

  const initialFilterForSource = initialSettingsEnabled.length === ALL_KINDS.length
    ? undefined
    : new Set(initialSettingsEnabled);

  const adapterSource = createApplicationSource({
    cacheDirectory: options.cacheDirectory,
    ...(initialFilterForSource === undefined ? {} : { filterProviders: initialFilterForSource }),
  });
  const clock = {
    wallNow: () => new Date(),
    monotonicNow: () => Number(process.hrtime.bigint()) / 1_000_000,
  };
  const fallback = emptyCollectionResult(clock.wallNow(), options.timezone);
  const coordinator = new RefreshCoordinator({
    source: adapterSource.source,
    clock,
    timezone: options.timezone,
    ...(options.project === undefined ? {} : { project: options.project }),
    refreshIntervalSeconds: initialSchedulerInterval,
    initialPeriod: options.period,
    ...(cached.snapshot === undefined ? {} : { initialSnapshot: cached.snapshot }),
  });
  const redraw = createStableRedraw();
  let help = false;
  let projectsVisible = false;
  let running = true;

  // Settings UI state
  const settingsState: {
    visible: boolean;
    enabledProviders: Set<ProviderKind>;
    refreshIntervalSeconds: number;
    focusedIndex: number;
  } = {
    visible: false,
    enabledProviders: new Set(initialSettingsEnabled),
    refreshIntervalSeconds: initialSettingsInterval,
    focusedIndex: 0,
  };
  let appliedEnabled = new Set(settingsState.enabledProviders);
  let appliedInterval = initialSchedulerInterval;

  const persistCurrentSettings = (): void => {
    void saveDashboardSettings({
      enabledProviders: [...settingsState.enabledProviders] as ProviderKind[],
      refreshIntervalSeconds: clampRefreshIntervalSeconds(settingsState.refreshIntervalSeconds),
    }, options.cacheDirectory);
  };

  const applySettings = (): void => {
    // Providers
    const enabledArray = [...settingsState.enabledProviders].sort();
    const appliedArray = [...appliedEnabled].sort();
    const providersChanged = enabledArray.length !== appliedArray.length || enabledArray.some((v, i) => v !== appliedArray[i]);
    if (providersChanged) {
      const newFilter = settingsState.enabledProviders.size === ALL_KINDS.length
        ? undefined
        : new Set(settingsState.enabledProviders);
      // Unified source is mutated via CachedUsageSource delegation
      try {
        adapterSource.source.setFilterProviders(newFilter);
      } catch (error) {
        debugWarn(io, "setFilterProviders (cached source) failed", error);
      }
      try {
        adapterSource.unified.setFilterProviders(newFilter);
      } catch (error) {
        debugWarn(io, "setFilterProviders (unified source) failed", error);
      }
      appliedEnabled = new Set(settingsState.enabledProviders);
      void coordinator.manualRefresh();
      persistCurrentSettings();
    }

    // Interval
    const clamped = clampRefreshIntervalSeconds(settingsState.refreshIntervalSeconds);
    if (clamped !== settingsState.refreshIntervalSeconds) {
      settingsState.refreshIntervalSeconds = clamped;
    }
    if (clamped !== appliedInterval) {
      try {
        coordinator.setRefreshIntervalSeconds(clamped);
      } catch (error) {
        debugWarn(io, "setRefreshIntervalSeconds failed", error);
      }
      appliedInterval = clamped;
      persistCurrentSettings();
    }
  };

  const draw = () => {
    const state = coordinator.getState();
    const input = dashboardInput(state, fallback, clock.wallNow(), clock.monotonicNow());
    const frame = renderDashboard(input, {
      isTTY: true,
      ansi: true,
      color: options.color,
      width: Math.max(20, io.stdout.columns || 100),
      now: clock.wallNow(),
      selectedWindow: state.period,
      help,
      ...(settingsState.visible
        ? {
            settings: {
              visible: true,
              enabledProviders: [...settingsState.enabledProviders].sort(),
              refreshIntervalSeconds: settingsState.refreshIntervalSeconds,
              focusedIndex: settingsState.focusedIndex,
            },
          }
        : {}),
      ...(projectsVisible ? { projects: { visible: true } } : {}),
    });
    io.stdout.write(redraw.render(frame, { isTTY: true, ansi: true, color: options.color }));
  };

  const stop = async () => {
    if (!running) return;
    running = false;
    await coordinator.quit();
    if (io.stdin.isTTY) io.stdin.setRawMode?.(false);
    io.stdin.pause();
    // Disable mouse tracking before restoring cursor
    if (io.stdout.isTTY) io.stdout.write(ANSI.mouseDisable);
    io.stdout.write(`\n${redraw.cleanup({ isTTY: true, ansi: true })}\n`);
  };

  coordinator.subscribe(() => draw());
  const onSignal = () => { void stop(); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  io.stdout.on("resize", draw);
  io.stdin.setRawMode?.(true);
  io.stdin.resume();
  io.stdout.write(ANSI.cursorHide);
  if (io.stdout.isTTY) io.stdout.write(ANSI.mouseEnable);
  draw();
  void coordinator.start().catch(() => undefined);

  let inputBuffer = "";
  let escapeFlushTimer: ReturnType<typeof setTimeout> | undefined;
  const clearEscapeFlush = (): void => {
    if (escapeFlushTimer !== undefined) {
      clearTimeout(escapeFlushTimer);
      escapeFlushTimer = undefined;
    }
  };
  const flushBufferedEscapeAsKey = (): void => {
    // A bare trailing ESC / ESC[ with no continuation after 50ms was a lone
    // ESC keypress, not a split sequence — handle it as the ESC key.
    escapeFlushTimer = undefined;
    if (inputBuffer !== "\u001b" && inputBuffer !== "\u001b[") return;
    inputBuffer = "";
    if (settingsState.visible) {
      settingsState.visible = false;
      draw();
    } else if (projectsVisible) {
      projectsVisible = false;
      draw();
    } else if (help) {
      help = false;
      draw();
    }
  };
  const scheduleEscapeFlush = (): void => {
    clearEscapeFlush();
    escapeFlushTimer = setTimeout(flushBufferedEscapeAsKey, 50);
    if (typeof escapeFlushTimer === "object" && escapeFlushTimer !== null && "unref" in escapeFlushTimer) {
      (escapeFlushTimer as unknown as { unref(): void }).unref();
    }
  };
  const onInput = (chunk: Buffer | string) => {
    clearEscapeFlush();
    inputBuffer += chunk.toString();
    const value = inputBuffer;
    inputBuffer = "";
    const periods: UsageWindowKind[] = ["hour", "day", "week"];
    const nextPeriod = (): UsageWindowKind => {
      const current = coordinator.getState().period;
      const idx = periods.indexOf(current);
      return periods[(idx + 1) % periods.length]!;
    };
    const prevPeriod = (): UsageWindowKind => {
      const current = coordinator.getState().period;
      const idx = periods.indexOf(current);
      return periods[(idx - 1 + periods.length) % periods.length]!;
    };
    let i = 0;
    while (i < value.length) {
      // Lone trailing ESC may be the first byte of a split sequence
      // ("\x1b" + "[A" across chunks). Buffer it and wait briefly; a lone
      // ESC keypress flushes via scheduleEscapeFlush after 50ms.
      if (value[i] === "\u001b" && i === value.length - 1) {
        inputBuffer = value.slice(i);
        scheduleEscapeFlush();
        break;
      }
      // SGR mouse click: \x1b[<Cb;Cx;CyM (press) / m (release)
      if (value.startsWith("\u001b[<", i)) {
        const termM = value.indexOf("M", i + 3);
        const termLower = value.indexOf("m", i + 3);
        let end = -1;
        let isPress = true;
        if (termM !== -1 && (termLower === -1 || termM < termLower)) {
          end = termM;
          isPress = true;
        } else if (termLower !== -1) {
          end = termLower;
          isPress = false;
        } else {
          // Incomplete SGR sequence — wait for next chunk
          inputBuffer = value.slice(i);
          break;
        }
        const body = value.slice(i + 3, end);
        const parts = body.split(";");
        if (parts.length === 3 && isPress) {
          const cb = Number(parts[0]);
          const cx = Number(parts[1]);
          const cy = Number(parts[2]);
          if (Number.isFinite(cb) && Number.isFinite(cx) && Number.isFinite(cy) && cb === 0) {
            if (!settingsState.visible && !projectsVisible) {
              const w = Math.max(20, io.stdout.columns || 100);
              const regions = getCardHitRegions(w);
              for (const r of regions) {
                if (cx >= r.x1 && cx <= r.x2 && cy >= r.y1 && cy <= r.y2) {
                  coordinator.setPeriod(r.kind);
                  draw();
                  break;
                }
              }
            }
          }
        }
        i = end + 1;
        continue;
      }
      if (value.startsWith("\u001b[", i)) {
        if (value.startsWith("\u001b[Z", i)) {
          if (settingsState.visible) {
            settingsState.focusedIndex = (settingsState.focusedIndex - 1 + 4) % 4;
            draw();
          } else {
            coordinator.setPeriod(prevPeriod());
          }
          i += 3;
          continue;
        }
        // Buffer an incomplete CSI split across data chunks (e.g. chunk ends
        // with "\x1b[" and "A" arrives next). The old `else i += 1` dropped it.
        if (i + 2 >= value.length) {
          inputBuffer = value.slice(i);
          scheduleEscapeFlush();
          break;
        }
        {
          const code = value[i + 2];
          if (settingsState.visible) {
            if (code === "A") {
              settingsState.focusedIndex = (settingsState.focusedIndex - 1 + 4) % 4;
              draw();
              i += 3;
              continue;
            }
            if (code === "B") {
              settingsState.focusedIndex = (settingsState.focusedIndex + 1) % 4;
              draw();
              i += 3;
              continue;
            }
            if (code === "C") {
              if (settingsState.focusedIndex === 3) {
                const next = adjustRefreshIntervalByPreset(settingsState.refreshIntervalSeconds, 1);
                if (next !== settingsState.refreshIntervalSeconds) {
                  settingsState.refreshIntervalSeconds = next;
                  applySettings();
                  draw();
                }
              }
              i += 3;
              continue;
            }
            if (code === "D") {
              if (settingsState.focusedIndex === 3) {
                const next = adjustRefreshIntervalByPreset(settingsState.refreshIntervalSeconds, -1);
                if (next !== settingsState.refreshIntervalSeconds) {
                  settingsState.refreshIntervalSeconds = next;
                  applySettings();
                  draw();
                }
              }
              i += 3;
              continue;
            }
          } else {
            if (code === "A" || code === "D") {
              coordinator.setPeriod(prevPeriod());
              i += 3;
              continue;
            }
            if (code === "B" || code === "C") {
              coordinator.setPeriod(nextPeriod());
              i += 3;
              continue;
            }
          }
        }
        i += 1;
        continue;
      }
      const key = value[i]!;
      if (key === "\u0003") {
        void stop();
        return;
      }
      if (projectsVisible) {
        if (key === "p" || key === "P" || key === "\u001b") {
          projectsVisible = false;
          draw();
          i += 1;
          continue;
        }
        if (key === "q") {
          projectsVisible = false;
          draw();
          i += 1;
          continue;
        }
        if (key === "s" || key === "S") {
          projectsVisible = false;
          settingsState.visible = true;
          help = false;
          draw();
          i += 1;
          continue;
        }
        if (key === "r" || key === "R") {
          void coordinator.manualRefresh();
          i += 1;
          continue;
        }
        if (key === "?") {
          projectsVisible = false;
          help = !help;
          draw();
          i += 1;
          continue;
        }
        if (key === "1" || key === "2" || key === "3") {
          coordinator.setPeriod(key === "1" ? "hour" : key === "2" ? "day" : "week");
          draw();
          i += 1;
          continue;
        }
        if (key === "\t" || key === "\u0009") {
          coordinator.setPeriod(nextPeriod());
          draw();
          i += 1;
          continue;
        }
        if (key === "\r" || key === "\n") {
          i += 1;
          continue;
        }
        i += 1;
        continue;
      }
      if (settingsState.visible) {
        if (key === "q" || key === "\u001b") {
          settingsState.visible = false;
          draw();
          i += 1;
          continue;
        }
        if (key === "p" || key === "P") {
          settingsState.visible = false;
          projectsVisible = true;
          help = false;
          draw();
          i += 1;
          continue;
        }
        if (key === "s" || key === "S") {
          settingsState.visible = false;
          draw();
          i += 1;
          continue;
        }
        if (key === "r" || key === "R") {
          void coordinator.manualRefresh();
          i += 1;
          continue;
        }
        if (key === "?") {
          // ignore ? inside settings; could close settings and toggle help
          i += 1;
          continue;
        }
        if (key === " ") {
          if (settingsState.focusedIndex >= 0 && settingsState.focusedIndex <= 2) {
            const prov = ALL_KINDS[settingsState.focusedIndex]!;
            if (settingsState.enabledProviders.has(prov)) {
              if (settingsState.enabledProviders.size > 1) {
                settingsState.enabledProviders.delete(prov);
                applySettings();
                draw();
              }
            } else {
              settingsState.enabledProviders.add(prov);
              applySettings();
              draw();
            }
          }
          i += 1;
          continue;
        }
        if (key === "\t" || key === "\u0009") {
          settingsState.focusedIndex = (settingsState.focusedIndex + 1) % 4;
          draw();
          i += 1;
          continue;
        }
        if (key === "1" || key === "2" || key === "3") {
          i += 1;
          continue;
        }
        if (key === "h" || key === "H") {
          if (settingsState.focusedIndex === 3) {
            const next = adjustRefreshIntervalByPreset(settingsState.refreshIntervalSeconds, -1);
            if (next !== settingsState.refreshIntervalSeconds) {
              settingsState.refreshIntervalSeconds = next;
              applySettings();
              draw();
            }
          }
          i += 1;
          continue;
        }
        if (key === "l" || key === "L") {
          if (settingsState.focusedIndex === 3) {
            const next = adjustRefreshIntervalByPreset(settingsState.refreshIntervalSeconds, 1);
            if (next !== settingsState.refreshIntervalSeconds) {
              settingsState.refreshIntervalSeconds = next;
              applySettings();
              draw();
            }
          }
          i += 1;
          continue;
        }
        if (key === "+" || key === "=") {
          if (settingsState.focusedIndex === 3) {
            const next = adjustRefreshIntervalByPreset(settingsState.refreshIntervalSeconds, 1);
            if (next !== settingsState.refreshIntervalSeconds) {
              settingsState.refreshIntervalSeconds = next;
              applySettings();
              draw();
            }
          }
          i += 1;
          continue;
        }
        if (key === "-" || key === "_") {
          if (settingsState.focusedIndex === 3) {
            const next = adjustRefreshIntervalByPreset(settingsState.refreshIntervalSeconds, -1);
            if (next !== settingsState.refreshIntervalSeconds) {
              settingsState.refreshIntervalSeconds = next;
              applySettings();
              draw();
            }
          }
          i += 1;
          continue;
        }
        if (key === "\r" || key === "\n") {
          if (settingsState.focusedIndex >= 0 && settingsState.focusedIndex <= 2) {
            const prov = ALL_KINDS[settingsState.focusedIndex]!;
            if (settingsState.enabledProviders.has(prov)) {
              if (settingsState.enabledProviders.size > 1) {
                settingsState.enabledProviders.delete(prov);
                applySettings();
                draw();
              }
            } else {
              settingsState.enabledProviders.add(prov);
              applySettings();
              draw();
            }
          }
          i += 1;
          continue;
        }
        if (key === "\u001b") {
          settingsState.visible = false;
          draw();
          i += 1;
          continue;
        }
        i += 1;
        continue;
      } else {
        if (key === "q") {
          void stop();
          return;
        }
        if (key === "r" || key === "R") {
          void coordinator.manualRefresh();
          i += 1;
          continue;
        }
        if (key === "?") {
          help = !help;
          draw();
          i += 1;
          continue;
        }
        if (key === "\t" || key === "\u0009") {
          coordinator.setPeriod(nextPeriod());
          i += 1;
          continue;
        }
        if (key === "1" || key === "2" || key === "3") {
          coordinator.setPeriod(key === "1" ? "hour" : key === "2" ? "day" : "week");
        }
        if (key === "p" || key === "P") {
          projectsVisible = true;
          help = false;
          settingsState.visible = false;
          draw();
          i += 1;
          continue;
        }
        if (key === "s" || key === "S") {
          settingsState.visible = true;
          help = false;
          projectsVisible = false;
          draw();
          i += 1;
          continue;
        }
        if (key === "\u001b") {
          if (help) {
            help = false;
            draw();
          }
          if (projectsVisible) {
            projectsVisible = false;
            draw();
          }
          i += 1;
          continue;
        }
        i += 1;
      }
    }
  };
  io.stdin.on("data", onInput);
  // Heartbeat is gated, not a blind 1s redraw: it fires only on clock
  // rollover (countdown text changes each second) or while a refresh is in
  // flight (spinner/progress). Idle dashboards skip redraw to save CPU.
  let lastHeartbeatSecond = Math.floor(Number(process.hrtime.bigint()) / 1_000_000_000);
  const heartbeat = setInterval(() => {
    if (!running) return;
    const state = coordinator.getState();
    const second = Math.floor(clock.monotonicNow() / 1000);
    const active = state.status === "refreshing";
    if (active || second !== lastHeartbeatSecond) {
      lastHeartbeatSecond = second;
      draw();
    }
  }, 1_000);
  if (typeof heartbeat === "object" && heartbeat !== null && "unref" in heartbeat) {
    (heartbeat as unknown as { unref(): void }).unref();
  }
  // Resize is debounced (120ms) so rapid terminal resizes render once.
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const onResize = (): void => {
    if (resizeTimer !== undefined) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined;
      if (running) draw();
    }, 120);
  };
  io.stdout.on("resize", onResize);
  await new Promise<void>((resolve) => {
    const check = () => running ? setTimeout(check, 25) : resolve();
    check();
  });
  clearInterval(heartbeat);
  if (resizeTimer !== undefined) clearTimeout(resizeTimer);
  clearEscapeFlush();
  io.stdin.off("data", onInput);
  io.stdout.off("resize", onResize);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  return 0;
}

export async function main(args = process.argv.slice(2), io: CliIO = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
}): Promise<number> {
  let options: CliOptions | "help" | "version" | undefined;
  try {
    options = parseArgs(args);
    if (options === "help") { io.stdout.write(usage()); return 0; }
    if (options === "version") { io.stdout.write(`${VERSION}\n`); return 0; }
    // Validate the IANA timezone before connecting to OpenCode.
    createUsageWindows(new Date(), options.timezone);
    if (options.command === "doctor") return runDoctor(options, io);
    if (options.once) return await runOnce(options, io);
    return await runDashboard(options, io);
  } catch (error) {
    writeError(io, error, requestedJSON(args));
    return 1;
  }
}

const invokedName = process.argv[1] === undefined ? "" : basename(process.argv[1]);
if ((invokedName === "oc2token" || invokedName === "cli.js") && !invokedName.endsWith(".test.js")) {
  void main().then((code) => { process.exitCode = code; });
}
