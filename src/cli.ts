#!/usr/bin/env node

import process from "node:process";
import { basename } from "node:path";

import {
  ANSI,
  createStableRedraw,
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
import { createUsageWindows, type UsageWindowKind } from "./domain/index.js";
import { runOpenCodeDoctor } from "./opencode/index.js";

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
  oc2token doctor [--json]

Options:
  --once                 Collect once and exit
  --json                 Emit stable JSON and exit
  --format <mode>        auto, dashboard, table, or json
  --refresh <seconds>    Automatic refresh cadence; 0 is manual-only
  --timezone <IANA>      Time zone for local day and ISO week boundaries
  --project <id>         Restrict collection to an OpenCode project
  --cache-dir <path>     Override the normalized metadata cache directory
  --no-color             Disable ANSI colors
  -h, --help             Show this help
  -v, --version          Show the version

Dashboard keys: r refresh, 1/2/3 select period, ? help, q quit.
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
  let timezone = DEFAULT_TIMEZONE;
  let project: string | undefined;
  let cacheDirectory: string | undefined;
  let color = true;
  let command: CliOptions["command"];
  let periodSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") return "help";
    if (arg === "-v" || arg === "--version") return "version";
    if (arg === "--once") { once = true; continue; }
    if (arg === "--json") { json = true; once = true; format = "json"; continue; }
    if (arg === "--no-color") { color = false; continue; }
    if (arg === "--refresh" || arg === "--timezone" || arg === "--project" || arg === "--cache-dir" || arg === "--format") {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) failUsage(`${arg} requires a value`);
      if (arg === "--refresh") refreshIntervalSeconds = parseSeconds(value);
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
  return { period, once, json, format, refreshIntervalSeconds, timezone, project, cacheDirectory, color, command };
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
  const report = await runOpenCodeDoctor({
    ensure: false,
    ...(options.project === undefined ? {} : { project: options.project }),
  });
  if (options.json || options.format === "json") {
    io.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    io.stdout.write(`OpenCode 2 doctor: ${report.ok ? "OK" : "FAILED"}\n`);
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
  const adapterSource = createApplicationSource({
    cacheDirectory: options.cacheDirectory,
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
    refreshIntervalSeconds: options.refreshIntervalSeconds,
    initialPeriod: options.period,
    ...(cached.snapshot === undefined ? {} : { initialSnapshot: cached.snapshot }),
  });
  const redraw = createStableRedraw();
  let help = false;
  let running = true;

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
    });
    io.stdout.write(redraw.render(frame, { isTTY: true, ansi: true, color: options.color }));
  };

  const stop = async () => {
    if (!running) return;
    running = false;
    await coordinator.quit();
    if (io.stdin.isTTY) io.stdin.setRawMode?.(false);
    io.stdin.pause();
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
  draw();
  void coordinator.start().catch(() => undefined);

  const onInput = (chunk: Buffer | string) => {
    const value = chunk.toString();
    for (const key of value) {
      if (key === "q" || key === "\u0003") { void stop(); return; }
      if (key === "r" || key === "R") { void coordinator.manualRefresh(); continue; }
      if (key === "?") { help = !help; draw(); continue; }
      if (key === "1" || key === "2" || key === "3") {
        coordinator.setPeriod(key === "1" ? "hour" : key === "2" ? "day" : "week");
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
