import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { basename, join, sep } from "node:path";

import type { LiveTpsMeter, LiveTpsReading, LiveTpsSnapshot } from "../opencode/live.js";
import { defaultAntigravityHome } from "./discovery.js";

export interface AntigravityLiveTpsMeterOptions {
  /** Override Antigravity home or brain directory for testing. */
  readonly root?: string;
  /** Override `Date.now` for deterministic tests. */
  readonly now?: () => number;
  /** Fallback poll interval in ms when watching or rescanning. */
  readonly pollIntervalMs?: number;
}

const MIN_STEP_MS = 1_000;
const MAX_STEP_MS = 30_000;
const DEFAULT_STEP_MS = 3_000;
const HOLD_MS = 5_000;
const AVERAGE_WINDOW_MS = 10 * 60 * 1_000;
const PRUNE_MS = 30_000;
const WATCH_RESCAN_MS = 10_000;
const POLL_FALLBACK_MS = 1_000;
const MAX_TAIL_BYTES = 1_048_576;
const TRANSCRIPT_SUFFIX = join(".system_generated", "logs", "transcript.jsonl");

interface AgySessionState {
  lastObservedAt?: number;
  lastStepWallAt?: number;
  rate: number;
  expiresAt: number;
  lastSeen: number;
}

function resolveHome(root?: string): string {
  if (root !== undefined) return root;
  const env = process.env.ANTIGRAVITY_HOME;
  if (typeof env === "string" && env.trim().length > 0) return env;
  return defaultAntigravityHome();
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Locate the Antigravity CLI `brain` directory containing per-session
 * `transcript.jsonl` logs. Supports `ANTIGRAVITY_HOME` or an explicit `root`.
 */
export function discoverAntigravityBrainDir(root?: string): string | undefined {
  const base = resolveHome(root);
  const candidates = [
    join(base, ".gemini", "antigravity-cli", "brain"),
    join(base, "antigravity-cli", "brain"),
    join(base, "brain"),
  ];
  for (const candidate of candidates) {
    if (isDirectory(candidate)) return candidate;
  }
  if (basename(base) === "brain" && isDirectory(base)) return base;
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Estimates live TPS from Antigravity CLI `transcript.jsonl` step completions.
 *
 * Unlike OpenCode2's character-level SSE stream, `agy` writes completed steps
 * to `transcript.jsonl`. Each `PLANNER_RESPONSE` carries `output_tokens`; we
 * estimate its rate over the elapsed time since the previous step in that
 * session and hold that reading briefly so active agent loops stay smooth.
 */
export class AgyTpsAggregator {
  private readonly sessions = new Map<string, AgySessionState>();
  /** One-second token buckets for the 10-minute rolling average. */
  private readonly history = new Map<number, number>();

  reset(): void {
    this.sessions.clear();
    this.history.clear();
  }

  ingestLine(sessionID: string, rawLine: string, now: number): void {
    if (sessionID.length === 0) return;
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const record = parsed as Record<string, unknown>;
    if (typeof record.type !== "string") return;

    const stepWallAt = parseTimestampMs(record.created_at) ?? now;
    let session = this.sessions.get(sessionID);
    if (session === undefined) {
      session = {
        rate: 0,
        expiresAt: 0,
        lastSeen: now,
      };
      this.sessions.set(sessionID, session);
    }

    if (
      record.type === "PLANNER_RESPONSE" &&
      typeof record.output_tokens === "number" &&
      Number.isFinite(record.output_tokens) &&
      record.output_tokens > 0
    ) {
      const observedDelta =
        session.lastObservedAt !== undefined ? Math.max(0, now - session.lastObservedAt) : undefined;
      const wallDelta =
        session.lastStepWallAt !== undefined ? Math.max(0, stepWallAt - session.lastStepWallAt) : undefined;

      const rawDuration =
        observedDelta !== undefined && wallDelta !== undefined
          ? Math.max(observedDelta, wallDelta)
          : (observedDelta ?? wallDelta ?? DEFAULT_STEP_MS);
      const stepDurationMs = clamp(rawDuration, MIN_STEP_MS, MAX_STEP_MS);

      session.rate = record.output_tokens / (stepDurationMs / 1_000);
      session.expiresAt = now + HOLD_MS;

      const second = Math.floor(now / 1_000);
      this.history.set(second, (this.history.get(second) ?? 0) + record.output_tokens);
    }

    session.lastObservedAt = now;
    session.lastStepWallAt = stepWallAt;
    session.lastSeen = now;
  }

  snapshot(now: number): LiveTpsReading {
    this.pruneHistory(now);
    let tps = 0;
    let activeSessions = 0;

    for (const [sessionID, session] of this.sessions) {
      if (session.expiresAt > now && session.rate > 0) {
        tps += session.rate;
        activeSessions += 1;
      } else if (now - session.lastSeen > PRUNE_MS && session.expiresAt <= now) {
        this.sessions.delete(sessionID);
      }
    }

    return { tps, activeSessions };
  }

  /** Average TPS over the last 10 minutes, or the observed span when shorter. */
  averageTps(now: number): number {
    this.pruneHistory(now);
    if (this.history.size === 0) return 0;
    let total = 0;
    let firstSecond = Number.POSITIVE_INFINITY;
    for (const [second, tokens] of this.history) {
      total += tokens;
      firstSecond = Math.min(firstSecond, second);
    }
    const from = Math.max(firstSecond * 1_000, now - AVERAGE_WINDOW_MS);
    const elapsedMs = Math.max(1_000, now - from);
    return total / (elapsedMs / 1_000);
  }

  private pruneHistory(now: number): void {
    const cutoffSecond = Math.floor((now - AVERAGE_WINDOW_MS) / 1_000);
    for (const second of this.history.keys()) {
      if (second < cutoffSecond) this.history.delete(second);
    }
  }
}

/**
 * Tail Antigravity CLI `transcript.jsonl` files under `~/.gemini/antigravity-cli/brain`
 * and report live TPS across all active `agy` sessions.
 */
export function createAntigravityLiveTpsMeter(options: AntigravityLiveTpsMeterOptions = {}): LiveTpsMeter {
  const aggregator = new AgyTpsAggregator();
  const nowFn = options.now ?? Date.now;
  const offsets = new Map<string, number>();
  const partials = new Map<string, string>();
  const decoder = new TextDecoder("utf-8", { fatal: false });

  let running = false;
  let available = false;
  let brainDir: string | undefined;
  let watcher: FSWatcher | undefined;
  let rescanTimer: ReturnType<typeof setInterval> | undefined;

  function transcriptPath(dir: string, sessionID: string): string {
    return join(dir, sessionID, TRANSCRIPT_SUFFIX);
  }

  function tailFile(filePath: string, sessionID: string, seedOnly: boolean): void {
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      return;
    }

    let offset = offsets.get(filePath);
    if (offset === undefined) {
      if (seedOnly) {
        offsets.set(filePath, size);
        return;
      }
      offset = 0;
    }

    if (size === offset) return;
    if (size < offset) {
      // Truncated or replaced; restart from the beginning.
      offset = 0;
      partials.delete(filePath);
    }

    const toRead = Math.min(size - offset, MAX_TAIL_BYTES);
    const readStart = size - toRead > offset ? size - toRead : offset;
    const length = size - readStart;
    if (length <= 0) return;

    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    let fd: number | undefined;
    try {
      fd = openSync(filePath, "r");
      bytesRead = readSync(fd, buffer, 0, length, readStart);
    } catch {
      return;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // ignore close errors
        }
      }
    }

    if (bytesRead <= 0) return;
    offsets.set(filePath, readStart + bytesRead);

    const chunk = (partials.get(filePath) ?? "") + decoder.decode(buffer.subarray(0, bytesRead));
    const lines = chunk.split("\n");
    partials.set(filePath, lines.pop() ?? "");

    const now = nowFn();
    for (const line of lines) {
      aggregator.ingestLine(sessionID, line, now);
    }
  }

  function scanBrainDir(seedOnly: boolean): void {
    if (brainDir === undefined) {
      brainDir = discoverAntigravityBrainDir(options.root);
      available = brainDir !== undefined;
      if (brainDir === undefined) return;
    }

    let entries;
    try {
      entries = readdirSync(brainDir, { withFileTypes: true });
    } catch {
      available = false;
      brainDir = undefined;
      return;
    }

    available = true;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const sessionID = entry.name;
      const filePath = transcriptPath(brainDir, sessionID);
      if (!existsSync(filePath)) continue;
      tailFile(filePath, sessionID, seedOnly);
    }
  }

  function startWatcher(): void {
    if (brainDir === undefined || watcher !== undefined) return;
    try {
      watcher = watch(brainDir, { recursive: true }, (_eventType, filename) => {
        if (!running || brainDir === undefined || typeof filename !== "string") return;
        const normalized = filename.replace(/[/\\]+/g, sep);
        if (!normalized.endsWith("transcript.jsonl")) return;
        const sessionID = normalized.split(sep)[0];
        if (!sessionID) return;
        tailFile(transcriptPath(brainDir, sessionID), sessionID, false);
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      watcher = undefined;
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      offsets.clear();
      partials.clear();
      aggregator.reset();

      scanBrainDir(true);
      startWatcher();

      const intervalMs = options.pollIntervalMs ?? (watcher !== undefined ? WATCH_RESCAN_MS : POLL_FALLBACK_MS);
      rescanTimer = setInterval(() => {
        if (!running) return;
        const hadDir = brainDir !== undefined;
        scanBrainDir(!hadDir);
        if (!hadDir && brainDir !== undefined) startWatcher();
      }, intervalMs);
      if (typeof rescanTimer === "object" && rescanTimer !== null && "unref" in rescanTimer) {
        rescanTimer.unref();
      }
    },

    stop(): void {
      if (!running) return;
      running = false;
      watcher?.close();
      watcher = undefined;
      if (rescanTimer !== undefined) {
        clearInterval(rescanTimer);
        rescanTimer = undefined;
      }
      offsets.clear();
      partials.clear();
      aggregator.reset();
      brainDir = undefined;
      available = false;
    },

    snapshot(now = nowFn()): LiveTpsSnapshot {
      return {
        available,
        ...aggregator.snapshot(now),
        averageTps: aggregator.averageTps(now),
      };
    },
  };
}
