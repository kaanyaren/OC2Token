import { promises as nodeFs } from "node:fs";
import { basename } from "node:path";

import {
  containsInstant,
  createUsageRecord,
  DomainError,
  cancellationError,
  isCancellationError,
  toCollectionError,
  type CollectionError,
  type CollectionRequest,
  type CollectionResult,
  type TokenComponents,
  type UsageRecord,
} from "../domain/index.js";
import { UsageRecordReducer } from "../accounting/reducer.js";
import { buildRecordResult } from "../usage/record-result.js";
import { discoverPiSessionFiles } from "./discovery.js";
import type { PiEntry, PiMessage, PiSessionHeader, PiUsage } from "./types.js";

/** Guards against one giant session file exhausting memory. */
const MAX_SESSION_BYTES = 256 * 1024 * 1024;

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    throw cancellationError(reason instanceof Error ? reason.message : undefined);
  }
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function sanitizeRecordID(value: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f/]/g, "_").trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function parseTimestamp(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    // Pi stores nested message timestamps in milliseconds; accept whole
    // seconds too so old exports do not land in 1970.
    const milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }
  return undefined;
}

/**
 * Pi reports reasoning inside `output` (`usage.reasoning` is a subset), while
 * this project's accounting sums output and reasoning as separate buckets.
 * Subtract it so `recorded_total` never double-counts.
 */
function tokensForUsage(usage: PiUsage): TokenComponents {
  const reasoning = safeNumber(usage.reasoning);
  const output = Math.max(0, safeNumber(usage.output) - reasoning);
  return {
    input: safeNumber(usage.input),
    output,
    reasoning,
    cacheRead: safeNumber(usage.cacheRead),
    cacheWrite: safeNumber(usage.cacheWrite),
  };
}

function modelName(provider: string | undefined, model: string | undefined): string {
  const trimmedModel = model?.trim();
  const trimmedProvider = provider?.trim();
  if (trimmedModel === undefined || trimmedModel.length === 0) return "unknown";
  if (trimmedProvider === undefined || trimmedProvider.length === 0 || trimmedModel.startsWith(`${trimmedProvider}/`)) {
    return trimmedModel;
  }
  return `${trimmedProvider}/${trimmedModel}`;
}

function inRequestedWindow(request: CollectionRequest, createdAt: Date): boolean {
  return request.windows.some((window) => containsInstant(window, createdAt));
}

interface ScanState {
  readonly errors: CollectionError[];
  readonly records: UsageRecord[];
  fileHasError: boolean;
}

function addError(
  state: ScanState,
  error: unknown,
  fallback: "transport" | "protocol" | "invalid-data",
  sessionID: string,
): void {
  state.fileHasError = true;
  state.errors.push(toCollectionError(error, fallback, sessionID));
}

function addUsageRecord(
  state: ScanState,
  request: CollectionRequest,
  sessionID: string,
  messageID: string,
  createdAt: Date,
  model: string,
  usage: PiUsage,
  project: string | undefined,
): void {
  if (!inRequestedWindow(request, createdAt)) return;
  const tokens = tokensForUsage(usage);
  if (
    tokens.input === 0 &&
    tokens.output === 0 &&
    tokens.reasoning === 0 &&
    tokens.cacheRead === 0 &&
    tokens.cacheWrite === 0
  ) {
    return;
  }
  try {
    state.records.push(
      createUsageRecord({
        sessionID,
        messageID: sanitizeRecordID(messageID, `${createdAt.getTime()}`),
        createdAt,
        model,
        tokens,
        observedAt: new Date(request.capturedAt.getTime()),
        completeness: "final",
        provider: "pi",
        ...(project === undefined ? {} : { project }),
      }),
    );
  } catch (error) {
    addError(state, error, "invalid-data", sessionID);
  }
}

function usageOf(message: PiMessage | undefined): PiUsage | undefined {
  const usage = message?.usage;
  return usage !== null && typeof usage === "object" ? usage : undefined;
}

/**
 * Native Pi session scanner. Pi appends JSONL entries to
 * `<agent-dir>/sessions/--<cwd>--/<timestamp>_<id>.jsonl`; assistant messages
 * carry normalized usage and `usage` entries cover non-message model work
 * (for example cache warming). Forked sessions repeat their parent's history,
 * so a fork's pre-header entries are skipped to avoid double counting.
 */
export async function collectPi(request: CollectionRequest, root?: string): Promise<CollectionResult> {
  assertNotAborted(request.signal);
  if (request.windows.length === 0) {
    throw new DomainError("invalid-window", "Collection request must contain at least one usage window");
  }

  const files = discoverPiSessionFiles(root);
  const errors: CollectionError[] = [];
  const reducer = new UsageRecordReducer();
  let sessionsScanned = 0;
  let sessionsSkipped = 0;

  for (const filePath of files) {
    assertNotAborted(request.signal);
    const fileFallback = sanitizeRecordID(basename(filePath, ".jsonl"), "pi-session");
    const state: ScanState = { errors: [], records: [], fileHasError: false };

    let content: string;
    try {
      const stat = await nodeFs.stat(filePath);
      if (stat.size > MAX_SESSION_BYTES) {
        sessionsSkipped += 1;
        errors.push(
          toCollectionError(
            new DomainError("invalid-data", `Pi session file exceeds ${MAX_SESSION_BYTES} bytes`, {
              sessionID: fileFallback,
            }),
            "invalid-data",
            fileFallback,
          ),
        );
        continue;
      }
      content = await nodeFs.readFile(filePath, "utf8");
    } catch (error) {
      if (isCancellationError(error)) throw cancellationError();
      sessionsSkipped += 1;
      errors.push(toCollectionError(error, "transport", fileFallback));
      continue;
    }

    let sessionID = fileFallback;
    let project: string | undefined;
    let forkCutoffMs: number | undefined;
    let currentProvider: string | undefined;
    let currentModel: string | undefined;

    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      assertNotAborted(request.signal);
      const line = lines[index]!.trim();
      if (line.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        addError(state, error, "invalid-data", sessionID);
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        addError(
          state,
          new DomainError("invalid-data", "Pi session line is not an object", { sessionID }),
          "invalid-data",
          sessionID,
        );
        continue;
      }
      const entry = parsed as PiEntry;

      if (entry.type === "session") {
        const header = entry as PiSessionHeader;
        sessionID = sanitizeRecordID(
          typeof header.id === "string" && header.id.trim().length > 0 ? header.id : fileFallback,
          fileFallback,
        );
        if (typeof header.cwd === "string" && header.cwd.trim().length > 0) {
          project = header.cwd.trim();
        }
        const headerTime = parseTimestamp(header.timestamp);
        if (headerTime !== undefined && typeof header.parentSession === "string" && header.parentSession.length > 0) {
          // /fork and /clone copy the parent's entries with their original
          // timestamps. Anything before the new header is inherited, not new
          // billable work in this session.
          forkCutoffMs = headerTime.getTime();
        }
        continue;
      }

      if (entry.type === "model_change") {
        if (typeof entry.provider === "string" && entry.provider.trim().length > 0) {
          currentProvider = entry.provider.trim();
        }
        if (typeof entry.modelId === "string" && entry.modelId.trim().length > 0) {
          currentModel = entry.modelId.trim();
        }
        continue;
      }

      const entryTime = parseTimestamp(entry.timestamp) ?? parseTimestamp(entry.message?.timestamp);
      if (entryTime === undefined) {
        // Model/thinking changes and system entries may omit timestamps; only
        // usage-bearing rows need one.
        if (entry.usage !== undefined || entry.message?.usage !== undefined) {
          addError(
            state,
            new DomainError("invalid-data", "Usage entry has no valid timestamp", { sessionID }),
            "invalid-data",
            sessionID,
          );
        }
        continue;
      }
      if (forkCutoffMs !== undefined && entryTime.getTime() < forkCutoffMs) continue;

      const message = entry.message;
      if (entry.type === "message" && typeof message === "object" && message !== null) {
        if (typeof message.provider === "string" && message.provider.trim().length > 0) {
          currentProvider = message.provider.trim();
        }
        if (typeof message.model === "string" && message.model.trim().length > 0) {
          currentModel = message.model.trim();
        }
        const usage = usageOf(message);
        if (usage === undefined) continue;
        addUsageRecord(
          state,
          request,
          sessionID,
          entry.id ?? `message-${index}`,
          entryTime,
          modelName(message.provider ?? currentProvider, message.model ?? currentModel),
          usage,
          project,
        );
        continue;
      }

      if (entry.type === "usage") {
        const usage = entry.usage;
        if (usage === null || typeof usage !== "object") continue;
        addUsageRecord(
          state,
          request,
          sessionID,
          entry.id === undefined ? `usage-${index}` : `usage-${entry.id}`,
          entryTime,
          modelName(entry.provider ?? currentProvider, entry.model ?? currentModel),
          usage,
          project,
        );
        continue;
      }

      if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage !== undefined) {
        const usage = entry.usage;
        if (usage === null || typeof usage !== "object") continue;
        addUsageRecord(
          state,
          request,
          sessionID,
          entry.id === undefined ? `${entry.type}-${index}` : `${entry.type}-${entry.id}`,
          entryTime,
          modelName(currentProvider, currentModel),
          usage,
          project,
        );
      }
    }

    for (const record of state.records) reducer.upsert(record);
    errors.push(...state.errors);
    if (state.fileHasError) sessionsSkipped += 1;
    else sessionsScanned += 1;
  }

  assertNotAborted(request.signal);

  return buildRecordResult({
    capturedAt: request.capturedAt,
    windows: request.windows,
    source: "pi",
    records: reducer.records(),
    sessionsDiscovered: files.length,
    sessionsScanned,
    sessionsSkipped,
    pagesRead: files.length,
    errors,
  });
}
