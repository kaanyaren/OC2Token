#!/usr/bin/env node

import process from "node:process";
import { basename } from "node:path";

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
  SETTINGS_MAX_REFRESH_SECONDS,
  SETTINGS_MIN_REFRESH_SECONDS,
  adjustRefreshIntervalByPreset,
  clampRefreshIntervalSeconds,
  loadDashboardSettings,
  saveDashboardSettings,
} from "./dashboard/settings/index.js";

const VERSION = "0.1.0";
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
  --refresh <seconds>    Automatic refresh cadence; 0 is manual-only
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
    io.stdout.write(`${JSON.stringify({ schemaVersion: 1, error: { code: "oc2token", message } })}\n`);
  } else {
    io.stderr.write(`oc2token: ${message}\n`);
  }
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

async function runDashboard(options: CliOptions, io: CliIO): Promise<number> {
  if (!io.stdout.isTTY || !io.stdin.isTTY) {
    return runOnce({ ...options, once: true }, io);
  }

  // A corrupt/future cache is intentionally ignored; it is an optimization,
  // while the live service remains the only accounting authority.
  const cached = await readCachedSnapshot(options.cacheDirectory);

  // Load persisted settings and merge with CLI options. CLI explicit flags win.
  const persisted = await loadDashboardSettings(options.cacheDirectory);
  const ALL_KINDS: readonly ProviderKind[] = ["opencode", "codex", "antigravity"] as const;

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

  let initialSchedulerInterval: number;
  let initialSettingsInterval: number;
  if (options.refreshExplicit) {
    initialSchedulerInterval = options.refreshIntervalSeconds;
    initialSettingsInterval = initialSchedulerInterval === 0
      ? SETTINGS_MIN_REFRESH_SECONDS
      : clampRefreshIntervalSeconds(initialSchedulerInterval);
    // Clamp scheduler interval for settings range if explicit but out of bounds? Keep explicit 0 as manual, otherwise clamp
    if (initialSchedulerInterval !== 0) {
      initialSchedulerInterval = clampRefreshIntervalSeconds(initialSchedulerInterval);
    }
  } else if (persisted !== undefined) {
    initialSchedulerInterval = clampRefreshIntervalSeconds(persisted.refreshIntervalSeconds);
    initialSettingsInterval = initialSchedulerInterval;
  } else {
    initialSchedulerInterval = options.refreshIntervalSeconds;
    if (initialSchedulerInterval !== 0) {
      initialSchedulerInterval = clampRefreshIntervalSeconds(initialSchedulerInterval);
    }
    initialSettingsInterval = initialSchedulerInterval === 0
      ? SETTINGS_MIN_REFRESH_SECONDS
      : clampRefreshIntervalSeconds(initialSchedulerInterval);
    // Also respect the min/max for initial settings: if scheduler is 0 manual, settings defaults to 300
    if (options.refreshIntervalSeconds === 0) {
      initialSettingsInterval = 300;
    }
  }
  // Ensure settings interval always within 1m..4h
  initialSettingsInterval = clampRefreshIntervalSeconds(initialSettingsInterval);

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
      } catch {}
      try {
        adapterSource.unified.setFilterProviders(newFilter);
      } catch {}
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
      } catch {}
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
  const onInput = (chunk: Buffer | string) => {
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
        if (i + 2 < value.length) {
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
            const provs: readonly ProviderKind[] = ["opencode", "codex", "antigravity"] as const;
            const prov = provs[settingsState.focusedIndex]!;
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
            const provs: readonly ProviderKind[] = ["opencode", "codex", "antigravity"] as const;
            const prov = provs[settingsState.focusedIndex]!;
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
  const heartbeat = setInterval(draw, 1_000);
  await new Promise<void>((resolve) => {
    const check = () => running ? setTimeout(check, 25) : resolve();
    check();
  });
  clearInterval(heartbeat);
  io.stdin.off("data", onInput);
  io.stdout.off("resize", draw);
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
