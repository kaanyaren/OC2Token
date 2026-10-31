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
import { discoverDeepSeekSessionFiles } from "./discovery.js";
import type {
  DeepSeekEntry,
  DeepSeekModelCall,
  DeepSeekSessionHeader,
  DeepSeekStreamRecord,
  DeepSeekTokenUsage,
} from "./types.js";
import { isZstdDecompressionAvailable, readZstdFile } from "./zstd.js";

const MAX_SESSION_BYTES = 256 * 1024 * 1024;

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    throw cancellationError(reason instanceof Error ? reason.message : undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function sanitizeRecordID(value: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f/]/g, "_").trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function isTokenUsage(value: unknown): value is DeepSeekTokenUsage {
  if (!isRecord(value)) return false;
  return typeof value.inputTokens === "number" && typeof value.outputTokens === "number";
}

/**
 * dsh reports `reasoningTokens` as informational detail already included in
 * `outputTokens` (and its cache counters are disjoint from input). Subtract
 * reasoning from output so this project's five-bucket sum stays exact.
 */
function tokensForUsage(usage: DeepSeekTokenUsage): TokenComponents {
  const reasoning = safeNumber(usage.reasoningTokens);
  const output = Math.max(0, safeNumber(usage.outputTokens) - reasoning);
  return {
    input: safeNumber(usage.inputTokens),
    output,
    reasoning,
    cacheRead: safeNumber(usage.cacheReadTokens),
    cacheWrite: safeNumber(usage.cacheWriteTokens),
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

function streamUsage(stream: unknown): DeepSeekTokenUsage | undefined {
  if (!Array.isArray(stream)) return undefined;
  let found: DeepSeekTokenUsage | undefined;
  for (const record of stream as DeepSeekStreamRecord[]) {
    if (!isRecord(record) || record.type !== "chunk") continue;
    const chunk = record.chunk;
    if (!isRecord(chunk) || chunk.type !== "usage") continue;
    if (isTokenUsage(chunk.usage)) found = chunk.usage;
  }
  return found;
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
  usage: DeepSeekTokenUsage,
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
        provider: "deepseek",
        ...(project === undefined ? {} : { project }),
      }),
    );
  } catch (error) {
    addError(state, error, "invalid-data", sessionID);
  }
}

function messageModel(message: unknown): DeepSeekModelCall | undefined {
  if (!isRecord(message)) return undefined;
  const source = message.source;
  if (!isRecord(source)) return undefined;
  const provider = typeof source.provider === "string" ? source.provider : undefined;
  const model = typeof source.model === "string" ? source.model : undefined;
  return provider !== undefined || model !== undefined ? { provider: provider ?? "", model: model ?? "" } : undefined;
}

function eventTime(entry: DeepSeekEntry, headerCreatedAt: number | undefined): Date | undefined {
  const raw = typeof entry.time === "number" ? entry.time : headerCreatedAt;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

/**
 * Native DeepSeek Harness scanner. Reads `${DSH_HOME:-~/.dsh}/sessions` and
 * selects the newest `session[.vN].jsonl[.zstd]` generation in each session
 * directory. Token accounting lives on `assistant/message` events (top-level
 * usage, falling back to the embedded stream), failed `assistant/attempt`
 * streams, and `compaction/summary` calls.
 */
export async function collectDeepSeek(request: CollectionRequest, root?: string): Promise<CollectionResult> {
  assertNotAborted(request.signal);
  if (request.windows.length === 0) {
    throw new DomainError("invalid-window", "Collection request must contain at least one usage window");
  }

  const files = discoverDeepSeekSessionFiles(root);
  const errors: CollectionError[] = [];
  const reducer = new UsageRecordReducer();
  let sessionsScanned = 0;
  let sessionsSkipped = 0;

  for (const file of files) {
    assertNotAborted(request.signal);
    const fallbackID = sanitizeRecordID(
      basename(file.path, file.compressed ? ".jsonl.zstd" : ".jsonl"),
      "deepseek-session",
    );
    const state: ScanState = { errors: [], records: [], fileHasError: false };

    let content: string;
    try {
      const stat = await nodeFs.stat(file.path);
      if (stat.size > MAX_SESSION_BYTES) {
        sessionsSkipped += 1;
        errors.push(
          toCollectionError(
            new DomainError("invalid-data", `DeepSeek session file exceeds ${MAX_SESSION_BYTES} bytes`, {
              sessionID: fallbackID,
            }),
            "invalid-data",
            fallbackID,
          ),
        );
        continue;
      }
      const buffer = await nodeFs.readFile(file.path);
      if (file.compressed) {
        if (!isZstdDecompressionAvailable()) {
          throw new Error(
            "DeepSeek session is zstd-compressed but neither Node Zstandard support nor the zstd CLI is available",
          );
        }
        content = readZstdFile(file.path, buffer).toString("utf8");
      } else {
        content = buffer.toString("utf8");
      }
    } catch (error) {
      if (isCancellationError(error)) throw cancellationError();
      sessionsSkipped += 1;
      errors.push(toCollectionError(error, "transport", fallbackID));
      continue;
    }

    const entries: DeepSeekEntry[] = [];
    for (const rawLine of content.split("\n")) {
      assertNotAborted(request.signal);
      const line = rawLine.trim();
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isRecord(parsed)) {
          throw new DomainError("invalid-data", "DeepSeek session line is not an object");
        }
        entries.push(parsed as DeepSeekEntry);
      } catch (error) {
        addError(state, error, "invalid-data", fallbackID);
      }
    }

    const headerIndex = entries.findIndex((entry) => entry.type === "session");
    const header = headerIndex === -1 ? undefined : (entries[headerIndex] as DeepSeekSessionHeader);
    if (header === undefined) {
      addError(
        state,
        new DomainError("invalid-data", "DeepSeek session has no session header"),
        "invalid-data",
        fallbackID,
      );
    }

    const sessionID = sanitizeRecordID(
      typeof header?.id === "string" && header.id.trim().length > 0 ? header.id : fallbackID,
      fallbackID,
    );
    const project = typeof header?.cwd === "string" && header.cwd.trim().length > 0 ? header.cwd.trim() : undefined;

    // Seeded sessions (subagents/forks) log the inherited prefix followed by a
    // tagged end-seed marker; only events after the last marker are new work.
    let startIndex = 0;
    if (header?.isSeeded === true) {
      const markerIndex = entries.reduce(
        (found, entry, index) => (entry.type === "session/end-seed" ? index : found),
        -1,
      );
      if (markerIndex >= 0) startIndex = markerIndex + 1;
    }

    let current: DeepSeekModelCall = { provider: "", model: "" };
    for (let index = 0; index < entries.length; index += 1) {
      assertNotAborted(request.signal);
      const entry = entries[index]!;
      const data = isRecord(entry.data) ? entry.data : undefined;
      if (data === undefined) continue;

      // Model routing is inherited state: fold it even for the inherited
      // prefix so the first child-owned call can price correctly.
      if (entry.type === "request/header") {
        const route = isRecord(data.header) ? data.header.config : undefined;
        if (isRecord(route)) {
          const provider = typeof route.provider === "string" ? route.provider : current.provider;
          const model = typeof route.model === "string" ? route.model : current.model;
          current = { provider, model };
        }
        continue;
      }
      if (entry.type === "request/context") {
        const provider = typeof data.provider === "string" ? data.provider : current.provider;
        const model = typeof data.model === "string" ? data.model : current.model;
        current = { provider, model };
        continue;
      }

      if (index < startIndex || entry.type === "session/end-seed") continue;
      const createdAt = eventTime(entry, header?.createdAt);
      if (createdAt === undefined) continue;
      const suffix = typeof entry.seq === "number" ? String(entry.seq) : String(index);

      if (entry.type === "assistant/message") {
        const usage = isTokenUsage(data.usage) ? data.usage : streamUsage(data.stream);
        if (usage === undefined) continue;
        const messageSource = messageModel(data.message);
        addUsageRecord(
          state,
          request,
          sessionID,
          `assistant-${suffix}`,
          createdAt,
          modelName(messageSource?.provider ?? current.provider, messageSource?.model ?? current.model),
          usage,
          project,
        );
        continue;
      }

      if (entry.type === "assistant/attempt") {
        const usage = streamUsage(data.stream);
        if (usage === undefined) continue;
        addUsageRecord(
          state,
          request,
          sessionID,
          `attempt-${suffix}`,
          createdAt,
          modelName(current.provider, current.model),
          usage,
          project,
        );
        continue;
      }

      if (entry.type === "compaction/summary") {
        if (!isTokenUsage(data.usage)) continue;
        addUsageRecord(
          state,
          request,
          sessionID,
          `compaction-${suffix}`,
          createdAt,
          modelName(
            typeof data.provider === "string" ? data.provider : current.provider,
            typeof data.model === "string" ? data.model : current.model,
          ),
          data.usage,
          project,
        );
        continue;
      }

      // Future/plugin events may carry the same TokenUsage shape. Count them
      // under their own id so a new usage-bearing event type is not lost.
      if (isTokenUsage(data.usage)) {
        addUsageRecord(
          state,
          request,
          sessionID,
          `${entry.type ?? "event"}-${suffix}`,
          createdAt,
          modelName(current.provider, current.model),
          data.usage,
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
    source: "deepseek",
    records: reducer.records(),
    sessionsDiscovered: files.length,
    sessionsScanned,
    sessionsSkipped,
    pagesRead: files.length,
    errors,
  });
}
