import {
  DomainError,
  cancellationError,
  isCancellationError,
  toCollectionError,
  type CollectionError,
} from "../domain/index.js";
import {
  createUsageRecord,
  sumUsageRecords,
  tokenRevisionFor,
  validateTokenComponents,
  type CollectionRequest,
  type CollectionResult,
  type Coverage,
  type MessageListRequest as ListMessagesRequest,
  type SessionListRequest as ListSessionsRequest,
  type MessagePage,
  type OpenCodeTransport,
  type SessionPage,
  type UsageRecord,
  type UsageWindow,
} from "../domain/index.js";
import { UsageRecordReducer } from "../accounting/reducer.js";
import { intervalUnion } from "./types.js";
import type {
  AssistantMessage,
  CollectorOptions,
  SessionSummary,
  UsageInterval,
} from "./types.js";

const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_WORKERS = 4;
const MAX_WORKERS = 32;
const MAX_PAGE_LIMIT = 1_000;

interface ResolvedOptions {
  readonly pageLimit: number;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly maxWorkers: number;
}

interface MutableCoverage {
  sessionsDiscovered: number;
  sessionsScanned: number;
  sessionsSkipped: number;
  pagesRead: number;
  jobsRetried: number;
  provisionalMessages: number;
  errors: CollectionError[];
}

interface ScanOutcome {
  readonly sessionID: string;
  readonly records: ReadonlyArray<UsageRecord>;
  readonly pagesRead: number;
  readonly jobsRetried: number;
  readonly provisionalMessages: number;
  readonly errors: ReadonlyArray<CollectionError>;
}

interface NormalizedPage<T> {
  readonly items: ReadonlyArray<T>;
  readonly nextCursor: string | undefined;
}

interface NormalizedMessage {
  readonly record?: UsageRecord;
  readonly error?: DomainError;
  readonly provisional: boolean;
}

function assertNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  throw cancellationError(reason instanceof Error ? reason.message : undefined);
}

function validInterval(interval: UsageInterval): UsageInterval {
  const from = interval.from instanceof Date ? interval.from.getTime() : Number.NaN;
  const to = interval.to instanceof Date ? interval.to.getTime() : Number.NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new DomainError("invalid-window", "Collection interval must have valid from < to instants");
  }
  return { from: new Date(from), to: new Date(to) };
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new RangeError(name + " must be a positive safe integer");
  }
  return result;
}

function resolvedOptions(
  defaults: CollectorOptions,
): ResolvedOptions {
  const pageLimit = positiveInteger(
    defaults.pageLimit,
    DEFAULT_PAGE_LIMIT,
    "pageLimit",
  );
  const maxRetries = defaults.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = defaults.retryDelayMs ?? 0;
  const maxWorkers = defaults.maxWorkers ?? 4;

  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError("maxRetries must be a non-negative safe integer");
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new RangeError("retryDelayMs must be a finite non-negative number");
  }
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers <= 0 || maxWorkers > MAX_WORKERS) {
    throw new RangeError("maxWorkers must be between 1 and " + MAX_WORKERS);
  }
  if (pageLimit > MAX_PAGE_LIMIT) {
    throw new RangeError("pageLimit must not exceed " + MAX_PAGE_LIMIT);
  }
  return { pageLimit, maxRetries, retryDelayMs, maxWorkers };
}

function sessionIDOf(session: SessionSummary): string {
  const id = session.id ?? session.sessionID;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new DomainError("invalid-data", "Session page contained a session without an id");
  }
  return id;
}

function pageItems<T extends object>(raw: unknown, names: ReadonlyArray<string>): ReadonlyArray<T> {
  if (Array.isArray(raw)) return raw as ReadonlyArray<T>;
  if (typeof raw !== "object" || raw === null) {
    throw new DomainError("invalid-data", "OpenCode returned a non-object page");
  }
  const record = raw as Record<string, unknown>;
  for (const name of names) {
    if (name in record) {
      if (!Array.isArray(record[name])) {
        throw new DomainError("invalid-data", name + " must be an array");
      }
      return record[name] as ReadonlyArray<T>;
    }
  }
  throw new DomainError("invalid-data", "OpenCode page did not contain an item array");
}

function pageCursor(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if ("nextCursor" in record) {
    const next = record.nextCursor;
    if (next === null || next === undefined || next === "") return undefined;
    if (typeof next !== "string") {
      throw new DomainError("invalid-data", "nextCursor must be a string or null");
    }
    return next;
  }
  if (!("cursor" in record) || record.cursor === null || record.cursor === undefined || record.cursor === "") {
    return undefined;
  }
  if (typeof record.cursor === "string") return record.cursor;
  if (typeof record.cursor !== "object" || Array.isArray(record.cursor)) {
    throw new DomainError("invalid-data", "cursor must be a string, object, or null");
  }
  const next = (record.cursor as Record<string, unknown>).next;
  if (next === null || next === undefined || next === "") return undefined;
  if (typeof next !== "string") {
    throw new DomainError("invalid-data", "cursor.next must be a string or null");
  }
  return next;
}

function normalizeSessionPage(raw: SessionPage): NormalizedPage<SessionSummary> {
  return {
    items: pageItems<SessionSummary>(raw, ["data", "sessions", "items"]),
    nextCursor: pageCursor(raw),
  };
}

function normalizeMessagePage(raw: MessagePage): NormalizedPage<AssistantMessage> {
  return {
    items: pageItems<AssistantMessage>(raw, ["data", "messages", "items"]),
    nextCursor: pageCursor(raw),
  };
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = error as Record<string, unknown>;
  const candidates = [
    value.status,
    value.statusCode,
    (value.response as Record<string, unknown> | undefined)?.status,
  ];
  return candidates.find((candidate): candidate is number =>
    typeof candidate === "number" && Number.isInteger(candidate),
  );
}

function isRetryableReadError(error: unknown): boolean {
  if (isCancellationError(error)) return false;
  if (error instanceof DomainError) return error.retryable;
  const status = statusOf(error);
  if (status !== undefined) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
  if (typeof error === "object" && error !== null) {
    const value = error as Record<string, unknown>;
    if (value.retryable === true) return true;
    if (
      typeof value.code === "string" &&
      ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"].includes(value.code)
    ) return true;
  }
  return error instanceof Error && /timeout|timed out|temporar|reset|network/i.test(error.message);
}

function sleepWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) {
    assertNotAborted(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(cancellationError());
    }, { once: true });
  });
}

async function readWithRetry<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  options: ResolvedOptions,
  onRetry: () => void,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    assertNotAborted(signal);
    try {
      const value = await operation();
      assertNotAborted(signal);
      return value;
    } catch (error) {
      if (isCancellationError(error) || signal.aborted) throw cancellationError();
      if (attempt >= options.maxRetries || !isRetryableReadError(error)) throw error;
      onRetry();
      await sleepWithAbort(options.retryDelayMs * 2 ** attempt, signal);
    }
  }
}

function addError(
  coverage: MutableCoverage,
  error: unknown,
  fallback: "transport" | "protocol" | "invalid-data" = "transport",
  sessionID?: string,
): void {
  coverage.errors.push(toCollectionError(error, fallback, sessionID));
}

function fallbackFor(error: unknown): "transport" | "protocol" | "invalid-data" {
  if (error instanceof DomainError) {
    if (error.code === "protocol") return "protocol";
    if (error.code === "invalid-data" || error.code === "missing-token-components" || error.code === "invalid-token-components") {
      return "invalid-data";
    }
  }
  return "transport";
}

function parseDate(value: unknown, field: string): Date {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new DomainError("invalid-data", field + " must be a valid date");
    }
    return new Date(value.getTime());
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DomainError("invalid-data", field + " must be finite");
    const milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    if (!Number.isFinite(date.getTime())) {
      throw new DomainError("invalid-data", field + " must be a valid date");
    }
    return date;
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new DomainError("invalid-data", field + " must be a valid date");
    }
    return date;
  }
  throw new DomainError("invalid-data", field + " is required");
}

function messageType(message: AssistantMessage): string | undefined {
  // The shared OpenCodeTransport DTO has already filtered to assistant
  // messages and therefore has messageID/createdAt but no raw `type` field.
  const type = message.type ?? message.role ?? (message.messageID !== undefined ? "assistant" : undefined);
  return typeof type === "string" ? type : undefined;
}

function modelName(message: AssistantMessage): string {
  if (typeof message.model === "string" && message.model.trim().length > 0) return message.model;
  if (typeof message.model === "object" && message.model !== null) {
    const provider = message.model.providerID;
    const model = message.model.id;
    if (typeof provider === "string" && typeof model === "string" && provider && model) {
      return provider + "/" + model;
    }
    if (typeof model === "string" && model) return model;
  }
  return "unknown";
}

function isExplicitlyProvisional(message: AssistantMessage): boolean {
  return (
    message.provisional === true ||
    message.completeness === "provisional" ||
    ["streaming", "running", "pending", "incomplete"].includes(message.status ?? "")
  );
}

function projectForSession(session: SessionSummary): string | undefined {
  const direct = (session as Record<string, unknown>).project as unknown;
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  const pid = session.projectID;
  if (typeof pid === "string" && pid.trim().length > 0) {
    // Prefer directory when available for human readability, otherwise projectID
    const dir = session.directory;
    if (typeof dir === "string" && dir.trim().length > 0) return dir.trim();
    return pid.trim();
  }
  const dir = session.directory;
  if (typeof dir === "string" && dir.trim().length > 0) return dir.trim();
  const location = (session as Record<string, unknown>).location as unknown;
  if (location !== null && typeof location === "object") {
    const loc = location as Record<string, unknown>;
    if (typeof loc.directory === "string" && (loc.directory as string).trim().length > 0) return (loc.directory as string).trim();
  }
  return undefined;
}

function normalizeAssistantMessage(
  message: AssistantMessage,
  sessionID: string,
  observedAt: Date,
  interval: UsageInterval,
  observationOrdinal: number,
  project?: string,
): NormalizedMessage {
  const type = messageType(message);
  if (type !== undefined && type !== "assistant") return { provisional: false };
  if (type === undefined) {
    return {
      provisional: true,
      error: new DomainError("invalid-data", "Message page contained a message without a type"),
    };
  }

  const messageID = message.id ?? message.messageID;
  if (typeof messageID !== "string" || messageID.trim().length === 0) {
    return {
      provisional: true,
      error: new DomainError("invalid-data", "Assistant message did not contain an id"),
    };
  }

  let createdAt: Date;
  try {
    createdAt = parseDate(message.time?.created ?? message.createdAt, "assistant.time.created");
  } catch (error) {
    return {
      provisional: true,
      error: error instanceof DomainError
        ? error
        : new DomainError("invalid-data", "Assistant message date is invalid", { cause: error }),
    };
  }

  if (createdAt.getTime() < interval.from.getTime() || createdAt.getTime() >= interval.to.getTime()) {
    return { provisional: false };
  }

  const validation = validateTokenComponents(message.tokens);
  if (!validation.ok) return { provisional: true, error: validation.error };

  const completeness = isExplicitlyProvisional(message) ? "provisional" : "final";
  const rawRevision = message.tokenRevision ?? message.revision ?? message.version;
  // The normalized domain DTO does not expose a server revision. A scan
  // ordinal is therefore the deterministic newest-observation tie breaker for
  // duplicate pages; an explicit transport revision remains authoritative.
  const tokenRevision = rawRevision === undefined
    ? "scan:" + String(observationOrdinal).padStart(12, "0") + ":" + tokenRevisionFor(validation.value, completeness)
    : String(rawRevision);

  try {
    return {
      provisional: completeness === "provisional",
      record: createUsageRecord({
        sessionID,
        messageID,
        createdAt,
        model: modelName(message),
        tokens: validation.value,
        observedAt,
        completeness,
        tokenRevision,
        ...(project === undefined ? {} : { project }),
      }),
    };
  } catch (error) {
    return {
      provisional: true,
      error: error instanceof DomainError
        ? error
        : new DomainError("invalid-data", "Assistant message could not be normalized", { cause: error }),
    };
  }
}

async function discoverSessions(
  transport: OpenCodeTransport,
  request: CollectionRequest,
  signal: AbortSignal,
  options: ResolvedOptions,
  coverage: MutableCoverage,
): Promise<ReadonlyArray<SessionSummary>> {
  const sessions = new Map<string, SessionSummary>();
  const addSessions = (items: ReadonlyArray<SessionSummary>) => {
    for (const item of items) {
      const id = sessionIDOf(item);
      if (!sessions.has(id)) {
        sessions.set(id, item);
        coverage.sessionsDiscovered += 1;
      }
    }
  };

  const enumerate = async (
    parentID: string | undefined,
    fetchPage: (input: ListSessionsRequest & { readonly parentID?: string }) => Promise<SessionPage>,
  ): Promise<void> => {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    try {
      for (;;) {
        assertNotAborted(signal);
        const page = await readWithRetry(
          () => fetchPage({
            ...(cursor === undefined ? {} : { cursor }),
            limit: options.pageLimit,
            ...(request.project === undefined ? {} : { project: request.project }),
            signal,
            ...(parentID === undefined ? {} : { parentID }),
          }),
          signal,
          options,
          () => { coverage.jobsRetried += 1; },
        );
        coverage.pagesRead += 1;
        const normalized = normalizeSessionPage(page);
        addSessions(normalized.items);
        if (normalized.nextCursor === undefined) return;
        if (seenCursors.has(normalized.nextCursor) || normalized.nextCursor === cursor) {
          throw new DomainError("protocol", "Repeated session cursor: " + normalized.nextCursor);
        }
        seenCursors.add(normalized.nextCursor);
        cursor = normalized.nextCursor;
      }
    } catch (error) {
      if (isCancellationError(error)) throw cancellationError();
      addError(coverage, error, fallbackFor(error), parentID);
    }
  };

  await enumerate(undefined, (input) => transport.listSessions(input));
  const includeSubagents = request.includeSubagents !== false;
  return [...sessions.values()]
    .filter((session) => {
      if (includeSubagents) return true;
      const parent = session.parentSessionID ?? session.parentID;
      return typeof parent !== "string" || parent.length === 0;
    })
    .sort((left, right) => sessionIDOf(left).localeCompare(sessionIDOf(right)));
}

async function scanSession(
  transport: OpenCodeTransport,
  session: SessionSummary,
  request: CollectionRequest,
  interval: UsageInterval,
  observedAt: Date,
  signal: AbortSignal,
  options: ResolvedOptions,
): Promise<ScanOutcome> {
  const sessionID = sessionIDOf(session);
  const project = projectForSession(session);
  const records: UsageRecord[] = [];
  const errors: CollectionError[] = [];
  let pagesRead = 0;
  let jobsRetried = 0;
  let provisionalMessages = 0;
  let observationOrdinal = 0;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  try {
    for (;;) {
      assertNotAborted(signal);
      const page = await readWithRetry(
        () => {
          const input: ListMessagesRequest = {
            sessionID,
            ...(cursor === undefined ? {} : { cursor }),
            limit: options.pageLimit,
            signal,
          };
          return transport.listMessages(input);
        },
        signal,
        options,
        () => { jobsRetried += 1; },
      );
      pagesRead += 1;
      const normalized = normalizeMessagePage(page);
      for (const message of normalized.items) {
        const normalizedMessage = normalizeAssistantMessage(
          message,
          sessionID,
          observedAt,
          interval,
          observationOrdinal,
          project,
        );
        observationOrdinal += 1;
        if (normalizedMessage.provisional) provisionalMessages += 1;
        if (normalizedMessage.error !== undefined) {
          errors.push(toCollectionError(normalizedMessage.error, "invalid-data", sessionID));
        }
        if (normalizedMessage.record !== undefined) records.push(normalizedMessage.record);
      }
      if (normalized.nextCursor === undefined) break;
      if (seenCursors.has(normalized.nextCursor) || normalized.nextCursor === cursor) {
        throw new DomainError(
          "protocol",
          "Repeated message cursor for " + sessionID + ": " + normalized.nextCursor,
          { sessionID },
        );
      }
      seenCursors.add(normalized.nextCursor);
      cursor = normalized.nextCursor;
    }
  } catch (error) {
    if (isCancellationError(error)) throw cancellationError();
    errors.push(toCollectionError(error, fallbackFor(error), sessionID));
  }

  return { sessionID, records, pagesRead, jobsRetried, provisionalMessages, errors };
}

async function runWorkers(
  transport: OpenCodeTransport,
  sessions: ReadonlyArray<SessionSummary>,
  request: CollectionRequest,
  interval: UsageInterval,
  observedAt: Date,
  signal: AbortSignal,
  options: ResolvedOptions,
  workers: number,
): Promise<ReadonlyArray<ScanOutcome>> {
  const outcomes: Array<ScanOutcome | undefined> = new Array(sessions.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      assertNotAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      if (index >= sessions.length) return;
      try {
        outcomes[index] = await scanSession(
          transport,
          sessions[index],
          request,
          interval,
          observedAt,
          signal,
          options,
        );
      } catch (error) {
        if (isCancellationError(error)) throw cancellationError();
        const sessionID = sessions[index]?.id ?? sessions[index]?.sessionID;
        outcomes[index] = {
          sessionID: typeof sessionID === "string" ? sessionID : "unknown",
          records: [],
          pagesRead: 0,
          jobsRetried: 0,
          provisionalMessages: 0,
          errors: [toCollectionError(error, "unknown", typeof sessionID === "string" ? sessionID : undefined)],
        };
      }
    }
  }

  const count = Math.min(workers, Math.max(1, sessions.length));
  const settled = await Promise.allSettled(Array.from({ length: count }, () => worker()));
  if (signal.aborted || settled.some((item) => item.status === "rejected" && isCancellationError(item.reason))) {
    throw cancellationError();
  }
  return outcomes.filter((outcome): outcome is ScanOutcome => outcome !== undefined);
}

function addOutcome(coverage: MutableCoverage, outcome: ScanOutcome): void {
  coverage.pagesRead += outcome.pagesRead;
  coverage.jobsRetried += outcome.jobsRetried;
  coverage.provisionalMessages += outcome.provisionalMessages;
  coverage.errors.push(...outcome.errors);
  if (outcome.errors.length === 0) coverage.sessionsScanned += 1;
  else coverage.sessionsSkipped += 1;
}

function sortedErrors(errors: ReadonlyArray<CollectionError>): ReadonlyArray<CollectionError> {
  return [...errors].sort((left, right) =>
    (String(left.sessionID ?? "") + "\0" + left.code + "\0" + left.message).localeCompare(
      String(right.sessionID ?? "") + "\0" + right.code + "\0" + right.message,
    ),
  );
}

async function collectInternal(
  transport: OpenCodeTransport,
  request: CollectionRequest,
  defaults: CollectorOptions,
  workerCount: number,
): Promise<CollectionResult> {
  if (request.windows.length === 0) {
    throw new DomainError("invalid-window", "Collection request must contain at least one usage window");
  }
  const interval = validInterval(intervalUnion(request.windows));
  const observedAt = parseDate(request.capturedAt, "capturedAt");
  const options = resolvedOptions(defaults);
  const signal = request.signal ?? new AbortController().signal;
  const coverage: MutableCoverage = {
    sessionsDiscovered: 0,
    sessionsScanned: 0,
    sessionsSkipped: 0,
    pagesRead: 0,
    jobsRetried: 0,
    provisionalMessages: 0,
    errors: [],
  };

  assertNotAborted(signal);
  const sessions = await discoverSessions(transport, request, signal, options, coverage);
  assertNotAborted(signal);
  const outcomes = await runWorkers(
    transport,
    sessions,
    request,
    interval,
    observedAt,
    signal,
    options,
    workerCount,
  );
  assertNotAborted(signal);
  for (const outcome of outcomes) addOutcome(coverage, outcome);

  const reducer = new UsageRecordReducer();
  for (const outcome of [...outcomes].sort((left, right) => left.sessionID.localeCompare(right.sessionID))) {
    reducer.upsertMany(outcome.records);
  }
  const records = reducer.records();
  const errors = sortedErrors(coverage.errors);
  const finalCoverage: Coverage = {
    complete: errors.length === 0 && coverage.sessionsSkipped === 0,
    sessionsDiscovered: coverage.sessionsDiscovered,
    sessionsScanned: coverage.sessionsScanned,
    sessionsSkipped: coverage.sessionsSkipped,
    pagesRead: coverage.pagesRead,
    jobsRetried: coverage.jobsRetried,
    provisionalMessages: coverage.provisionalMessages,
    errors,
  };

  // Project breakdowns per window (derived from records, similar to provider/model logic in UnifiedUsageSource)
  const projectsMutable: Record<string, ReadonlyArray<import("../domain/index.js").UsageBreakdown>> = {};
  for (const w of request.windows) {
    const windowRecords = records.filter((r) => r.project !== undefined && r.project.trim().length > 0 && (() => {
      // containsInstant check
      const t = r.createdAt.getTime();
      return t >= w.from.getTime() && t < w.to.getTime();
    })());
    if (windowRecords.length === 0) continue;
    const byProject = new Map<string, typeof windowRecords>();
    for (const r of windowRecords) {
      const proj = r.project!;
      const arr = byProject.get(proj);
      if (arr === undefined) byProject.set(proj, [r]);
      else arr.push(r);
    }
    if (byProject.size > 0) {
      const breakdowns: import("../domain/index.js").UsageBreakdown[] = [];
      for (const [projName, recs] of byProject.entries()) {
        const totals = sumUsageRecords(recs, w, { includeProvisional: request.includeProvisional === true });
        breakdowns.push({ name: projName, totals });
      }
      breakdowns.sort((a, b) => b.totals.recorded_total - a.totals.recorded_total || a.name.localeCompare(b.name));
      projectsMutable[w.kind] = breakdowns;
    }
  }
  const maybeProjects = Object.keys(projectsMutable).length > 0 ? { projectsByWindow: projectsMutable as import("../domain/index.js").UsageBreakdownsByWindow, projects: [...(projectsMutable.week ?? projectsMutable.day ?? projectsMutable.hour ?? Object.values(projectsMutable).flat())] } : {};

  return {
    capturedAt: observedAt,
    windows: request.windows.map((window) => ({
      ...window,
      from: new Date(window.from.getTime()),
      to: new Date(window.to.getTime()),
    })),
    source: "message-scan",
    records,
    totalsByWindow: Object.fromEntries(
      request.windows.map((window) => [
        window.kind,
        sumUsageRecords(records, window, { includeProvisional: request.includeProvisional === true }),
      ]),
    ),
    ...maybeProjects,
    coverage: finalCoverage,
  };
}

export async function collectUsageSerial(
  transport: OpenCodeTransport,
  request: CollectionRequest,
  options: CollectorOptions = {},
): Promise<CollectionResult> {
  return collectInternal(transport, request, options, 1);
}

export async function collectUsageParallel(
  transport: OpenCodeTransport,
  request: CollectionRequest,
  options: CollectorOptions = {},
): Promise<CollectionResult> {
  const workers = options.maxWorkers ?? DEFAULT_MAX_WORKERS;
  return collectInternal(transport, request, options, workers);
}

export const collectSerial = collectUsageSerial;
export const collectParallel = collectUsageParallel;
export type { CollectorOptions } from "./types.js";

export class UsageCollector {
  constructor(
    private readonly transport: OpenCodeTransport,
    private readonly options: CollectorOptions = {},
  ) {}

  collectSerial(request: CollectionRequest): Promise<CollectionResult> {
    return collectUsageSerial(this.transport, request, this.options);
  }

  collectParallel(request: CollectionRequest): Promise<CollectionResult> {
    return collectUsageParallel(this.transport, request, this.options);
  }

  collect(request: CollectionRequest, mode: "serial" | "parallel" = "parallel"): Promise<CollectionResult> {
    return mode === "serial" ? this.collectSerial(request) : this.collectParallel(request);
  }
}
