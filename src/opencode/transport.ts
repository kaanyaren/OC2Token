import {
  DomainError,
  cancellationError,
  isCancellationError,
  parseTokenComponents,
  toUsageTotals,
  type MessageListRequest,
  type MessagePage,
  type OpenCodeAssistantMessage,
  type OpenCodeHealth,
  type OpenCodeRange,
  type OpenCodeSession,
  type OpenCodeSessionStats,
  type OpenCodeTransport,
  type SessionListRequest,
  type SessionPage,
  type TokenComponentsInput,
  type TransportRequestOptions,
  type UsageBreakdown,
  type UsageWindow,
} from "../domain/index.js";
import type { OpenCodeClientLike } from "./client.js";

export interface RetryPolicy {
  /** Maximum number of attempts, including the first request. */
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Fractional jitter around the exponential delay. Set to zero in tests. */
  readonly jitter?: number;
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Per-attempt request deadline. Set to zero to disable the deadline. */
  readonly requestTimeoutMs?: number;
}

export interface StatsRequestOptions extends TransportRequestOptions {
  readonly project?: string;
}

export interface OpenCodeTransportOptions extends RetryPolicy {
  readonly client: OpenCodeClientLike;
  readonly pageSize?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 2_000;
const DEFAULT_JITTER = 0.2;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_PAGE_SIZE = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function statusFromError(error: unknown, seen = new Set<unknown>()): number | undefined {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) {
    return undefined;
  }
  if (seen.has(error)) return undefined;
  seen.add(error);

  const record = error as Record<string, unknown>;
  for (const candidate of [record.status, record.statusCode, record.response]) {
    if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
    if (candidate instanceof Response && Number.isInteger(candidate.status)) return candidate.status;
    const nested = statusFromError(candidate, seen);
    if (nested !== undefined) return nested;
  }
  return statusFromError(record.cause, seen);
}

function headersFromError(error: unknown, seen = new Set<unknown>()): Headers | undefined {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) {
    return undefined;
  }
  if (seen.has(error)) return undefined;
  seen.add(error);
  const record = error as Record<string, unknown>;
  if (record.headers instanceof Headers) return record.headers;
  if (isRecord(record.headers)) return new Headers(record.headers as Record<string, string>);
  if (record.response instanceof Response) return record.response.headers;
  return headersFromError(record.cause, seen);
}

function retryAfterMs(error: unknown, now = Date.now()): number | undefined {
  const value = headersFromError(error)?.get("retry-after");
  if (value === null || value === undefined || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - now);
}

function timeoutError(): DomainError {
  return new DomainError("transport", "OpenCode request timed out", {
    retryable: true,
  });
}

function abortError(): DomainError {
  return cancellationError();
}

function adapterError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;

  const status = statusFromError(error);
  if (status === 401 || status === 403) {
    return new DomainError("authentication", `OpenCode service rejected the request (${status})`, {
      cause: error,
    });
  }
  if (status === 429) {
    return new DomainError("rate-limited", "OpenCode service rate-limited the request", {
      retryable: true,
      cause: error,
    });
  }
  if (status === 408 || status === 425) {
    return new DomainError("transport", `OpenCode service returned HTTP ${status}`, {
      retryable: true,
      cause: error,
    });
  }
  if (status !== undefined && status >= 500) {
    return new DomainError("transport", `OpenCode service returned HTTP ${status}`, {
      retryable: true,
      cause: error,
    });
  }
  if (status !== undefined && status >= 400) {
    return new DomainError("protocol", `OpenCode service rejected the request (${status})`, {
      cause: error,
    });
  }

  const reason = isRecord(error) && typeof error.reason === "string" ? error.reason : undefined;
  if (reason === "MalformedResponse" || reason === "UnsupportedContentType") {
    return new DomainError("invalid-data", "OpenCode returned a malformed response", {
      cause: error,
    });
  }
  if (reason === "Transport" || reason === "UnexpectedStatus") {
    return new DomainError("transport", "OpenCode transport request failed", {
      retryable: true,
      cause: error,
    });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new DomainError("transport", "OpenCode request was aborted by its deadline", {
      retryable: true,
      cause: error,
    });
  }
  return new DomainError("transport", error instanceof Error ? error.message : String(error), {
    retryable: true,
    cause: error,
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

interface AttemptSignal {
  readonly signal: AbortSignal;
  readonly didTimeout: () => boolean;
  readonly dispose: () => void;
}

function makeAttemptSignal(parent: AbortSignal | undefined, timeoutMs: number): AttemptSignal {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent !== undefined) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", abortFromParent, { once: true });
  }
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Request timed out", "TimeoutError"));
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    if (signal === undefined) return;
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function backoffDelay(attempt: number, policy: Required<Pick<RetryPolicy, "baseDelayMs" | "maxDelayMs" | "jitter">> & Pick<RetryPolicy, "random">): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const random = Math.min(1, Math.max(0, policy.random?.() ?? Math.random()));
  const multiplier = 1 + (random * 2 - 1) * policy.jitter;
  return Math.max(0, Math.min(policy.maxDelayMs, Math.round(exponential * multiplier)));
}

export async function retryingRead<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: RetryPolicy & TransportRequestOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const jitter = Math.max(0, Math.min(1, options.jitter ?? DEFAULT_JITTER));
  const timeoutMs = Math.max(0, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const sleep = options.sleep ?? defaultSleep;
  const parent = options.signal;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(parent);
    const attemptSignal = makeAttemptSignal(parent, timeoutMs);
    try {
      const result = await abortable(operation(attemptSignal.signal), attemptSignal.signal);
      attemptSignal.dispose();
      throwIfAborted(parent);
      return result;
    } catch (error) {
      const timedOut = attemptSignal.didTimeout();
      attemptSignal.dispose();
      if (parent?.aborted) throw abortError();
      if (timedOut) error = timeoutError();

      const normalized = adapterError(error);
      const shouldRetry = normalized.retryable && attempt < maxAttempts;
      if (!shouldRetry) throw normalized;

      const retryAfter = normalized.code === "rate-limited" ? retryAfterMs(error) : undefined;
      const delay = Math.min(
        maxDelayMs,
        retryAfter ?? backoffDelay(attempt, { baseDelayMs, maxDelayMs, jitter, random: options.random }),
      );
      try {
        await sleep(delay, parent);
      } catch (sleepError) {
        if (parent?.aborted || isCancellationError(sleepError)) throw abortError();
        throw adapterError(sleepError);
      }
    }
  }

  throw new DomainError("transport", "OpenCode retry budget was exhausted");
}

function safeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number") {
    throw new DomainError("invalid-data", `${path} must be a safe integer`);
  }
  return value;
}

function dateFromMilliseconds(value: unknown, path: string): Date {
  const milliseconds = safeInteger(value, path);
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    throw new DomainError("invalid-data", `${path} must be a valid millisecond timestamp`);
  }
  return date;
}

function tokenInput(value: unknown): TokenComponentsInput {
  // parseTokenComponents deliberately performs the shared validation. The
  // returned flat form avoids retaining arbitrary provider response fields.
  const parsed = parseTokenComponents(value);
  return { ...parsed };
}

function unwrapData(value: unknown): unknown {
  if (isRecord(value) && isRecord(value.data) && !("range" in value)) return value.data;
  return value;
}

function parseStatsBreakdowns(raw: Record<string, unknown>): {
  readonly models?: ReadonlyArray<UsageBreakdown>;
  readonly providers?: ReadonlyArray<UsageBreakdown>;
} {
  if (!Array.isArray(raw.models)) return {};
  const models: UsageBreakdown[] = [];
  const providers = new Map<string, UsageBreakdown>();
  for (const [index, value] of raw.models.entries()) {
    if (!isRecord(value) || !isRecord(value.model)) {
      throw new DomainError("invalid-data", `stats.models[${index}] is malformed`);
    }
    const model = value.model;
    if (typeof model.id !== "string" || model.id.length === 0) {
      throw new DomainError("invalid-data", `stats.models[${index}].model.id is missing`);
    }
    const totals = toUsageTotals(parseTokenComponents(value.tokens));
    const provider = typeof model.providerID === "string" && model.providerID.length > 0
      ? model.providerID
      : undefined;
    models.push({ name: model.id, ...(provider === undefined ? {} : { provider }), totals });
    if (provider !== undefined) {
      const current = providers.get(provider);
      if (current === undefined) {
        providers.set(provider, { name: provider, totals });
      } else {
        const merged = {
          input: current.totals.input + totals.input,
          output: current.totals.output + totals.output,
          reasoning: current.totals.reasoning + totals.reasoning,
          cacheRead: current.totals.cacheRead + totals.cacheRead,
          cacheWrite: current.totals.cacheWrite + totals.cacheWrite,
        };
        providers.set(provider, { name: provider, totals: toUsageTotals(merged) });
      }
    }
  }
  return { models, providers: [...providers.values()] };
}

function parseStats(value: unknown, window: UsageWindow): OpenCodeSessionStats {
  const raw = unwrapData(value);
  if (!isRecord(raw) || !isRecord(raw.range)) {
    throw new DomainError("invalid-data", "OpenCode stats response is missing range");
  }
  const reportedFrom = dateFromMilliseconds(own(raw.range, "from"), "stats.range.from");
  const reportedTo = dateFromMilliseconds(own(raw.range, "to"), "stats.range.to");
  if (reportedFrom.getTime() >= reportedTo.getTime()) {
    throw new DomainError("invalid-data", "OpenCode stats response has an invalid range");
  }

  if (!("tokens" in raw)) {
    throw new DomainError("invalid-data", "OpenCode stats response is missing tokens");
  }
  let totals;
  try {
    totals = toUsageTotals(parseTokenComponents(raw.tokens));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("invalid-data", "OpenCode stats tokens could not be parsed", { cause: error });
  }

  const reportedRange: OpenCodeRange = {
    from: reportedFrom,
    to: reportedTo,
    timezone: window.timezone,
  };
  const requestedFrom = window.from.getTime();
  const requestedTo = window.to.getTime();
  const exact = reportedFrom.getTime() === requestedFrom && reportedTo.getTime() === requestedTo;
  if (!exact) {
    const broader = reportedFrom.getTime() < requestedFrom || reportedTo.getTime() > requestedTo;
    throw new StatsRangeMismatchError(window, reportedRange, broader);
  }

  return {
    requestedWindow: window,
    reportedRange,
    totals,
    ...parseStatsBreakdowns(raw),
  };
}

export const parseOpenCodeSessionStats = parseStats;

function parseCursor(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new DomainError("invalid-data", `${path} must be a non-empty string or null`);
  }
  return value;
}

function parseCursorEnvelope(value: unknown, path: string): { data: unknown[]; nextCursor: string | null } {
  if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.cursor)) {
    throw new DomainError("invalid-data", `${path} response must contain data and cursor`);
  }
  return {
    data: value.data,
    nextCursor: parseCursor(own(value.cursor, "next"), `${path}.cursor.next`),
  };
}

function parseSession(value: unknown, index: number): OpenCodeSession {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    throw new DomainError("invalid-data", `sessions.data[${index}] is missing id`);
  }
  if (value.parentID !== undefined && value.parentID !== null && typeof value.parentID !== "string") {
    throw new DomainError("invalid-data", `sessions.data[${index}].parentID is invalid`);
  }
  return {
    sessionID: value.id,
    ...(typeof value.parentID === "string" ? { parentSessionID: value.parentID } : {}),
  };
}

function parseModel(value: unknown, path: string): string {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    throw new DomainError("invalid-data", `${path} is missing model.id`);
  }
  if (value.providerID !== undefined && (typeof value.providerID !== "string" || value.providerID.length === 0)) {
    throw new DomainError("invalid-data", `${path}.providerID is invalid`);
  }
  return typeof value.providerID === "string" ? `${value.providerID}/${value.id}` : value.id;
}

function parseMessage(value: unknown, index: number, sessionID: string): OpenCodeAssistantMessage | undefined {
  if (!isRecord(value)) {
    throw new DomainError("invalid-data", `messages.data[${index}] is not an object`);
  }
  if (value.type !== "assistant") return undefined;
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new DomainError("invalid-data", `messages.data[${index}] is missing id`);
  }
  if (!isRecord(value.time)) {
    throw new DomainError("invalid-data", `messages.data[${index}] is missing time`);
  }
  const createdAt = dateFromMilliseconds(own(value.time, "created"), `messages.data[${index}].time.created`);
  const model = parseModel(value.model, `messages.data[${index}].model`);

  let tokens: TokenComponentsInput | undefined;
  if ("tokens" in value) tokens = tokenInput(value.tokens);

  let completed: number | undefined;
  if ("completed" in value.time && value.time.completed !== undefined) {
    completed = safeInteger(value.time.completed, `messages.data[${index}].time.completed`);
  }
  if ("finish" in value && value.finish !== undefined && typeof value.finish !== "string") {
    throw new DomainError("invalid-data", `messages.data[${index}].finish is invalid`);
  }
  const completeness = completed !== undefined || value.finish !== undefined ? "final" : "provisional";

  return {
    sessionID,
    messageID: value.id,
    createdAt,
    model,
    ...(tokens === undefined ? {} : { tokens }),
    completeness,
  };
}

function requestInput(cursor: string | undefined, limit: number): Record<string, unknown> {
  return {
    ...(cursor === undefined ? {} : { cursor }),
    limit,
  };
}

export class StatsRangeMismatchError extends DomainError {
  readonly requestedWindow: UsageWindow;
  readonly reportedRange: OpenCodeRange;
  readonly broader: boolean;

  constructor(requestedWindow: UsageWindow, reportedRange: OpenCodeRange, broader: boolean) {
    super(
      "protocol",
      broader
        ? "OpenCode stats response covered a broader range than requested"
        : "OpenCode stats response range did not exactly match the requested window",
    );
    this.requestedWindow = requestedWindow;
    this.reportedRange = reportedRange;
    this.broader = broader;
  }
}

export function isStatsRangeMismatch(error: unknown): error is StatsRangeMismatchError {
  return error instanceof StatsRangeMismatchError;
}

/**
 * Read-only V2 transport. Response parsing happens after the retry boundary so
 * malformed data is never retried and never mistaken for a transient outage.
 */
export class OpenCode2Transport implements OpenCodeTransport {
  readonly client: OpenCodeClientLike;
  readonly pageSize: number;
  readonly retryPolicy: RetryPolicy;

  constructor(options: OpenCodeTransportOptions) {
    this.client = options.client;
    this.pageSize = Math.max(1, Math.min(1_000, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE)));
    this.retryPolicy = { ...options };
  }

  async getHealth(options: TransportRequestOptions = {}): Promise<OpenCodeHealth> {
    // The transport cannot derive a safe fingerprint without the endpoint.
    // Callers that need the service fingerprint should use connectOpenCode;
    // this method still returns the stable API health metadata.
    const raw = await retryingRead(
      (signal) => this.client.health.get({ signal }),
      { ...this.retryPolicy, signal: options.signal },
    );
    if (!isRecord(raw) || raw.healthy !== true || typeof raw.version !== "string") {
      throw new DomainError("invalid-data", "OpenCode health response is malformed");
    }
    const pid = raw.pid;
    const fingerprint = `${raw.version}:${typeof pid === "number" ? pid : "unknown"}`;
    return { version: raw.version, fingerprint };
  }

  async getSessionStats(window: UsageWindow, options: StatsRequestOptions = {}): Promise<OpenCodeSessionStats> {
    const input = {
      from: window.from.getTime(),
      to: window.to.getTime(),
      ...(options.project === undefined ? {} : { project: options.project }),
      timezone: window.timezone,
      tools: "none" as const,
    };
    const raw = await retryingRead(
      (signal) => this.client.session.stats(input, { signal }),
      { ...this.retryPolicy, signal: options.signal },
    );
    return parseStats(raw, window);
  }

  async listSessions(request: SessionListRequest = {}): Promise<SessionPage> {
    const input = requestInput(request.cursor, Math.max(1, Math.min(1_000, Math.floor(request.limit ?? this.pageSize))));
    const raw = await retryingRead(
      (signal) => this.client.session.list(input, { signal }),
      { ...this.retryPolicy, signal: request.signal },
    );
    const envelope = parseCursorEnvelope(raw, "sessions");
    return {
      sessions: envelope.data.map(parseSession),
      nextCursor: envelope.nextCursor,
    };
  }

  async listMessages(request: MessageListRequest): Promise<MessagePage> {
    if (typeof request.sessionID !== "string" || request.sessionID.length === 0) {
      throw new DomainError("invalid-data", "message list requires a sessionID");
    }
    const input = {
      sessionID: request.sessionID,
      ...requestInput(request.cursor, Math.max(1, Math.min(1_000, Math.floor(request.limit ?? this.pageSize)))),
    };
    let raw: unknown;
    try {
      raw = await retryingRead(
        (signal) => this.client.message.list(input, { signal }),
        { ...this.retryPolicy, signal: request.signal },
      );
    } catch (error) {
      if (error instanceof DomainError && error.sessionID === undefined) {
        throw new DomainError(error.code, error.message, {
          retryable: error.retryable,
          sessionID: request.sessionID,
          cause: error,
        });
      }
      throw error;
    }
    const envelope = parseCursorEnvelope(raw, "messages");
    const messages = envelope.data.flatMap((value, index) => {
      const message = parseMessage(value, index, request.sessionID);
      return message === undefined ? [] : [message];
    });
    return { messages, nextCursor: envelope.nextCursor };
  }

  async listAllSessions(options: SessionListRequest & { readonly maxPages?: number } = {}): Promise<ReadonlyArray<OpenCodeSession>> {
    const pages = Math.max(1, Math.floor(options.maxPages ?? 10_000));
    const sessions: OpenCodeSession[] = [];
    const seenCursors = new Set<string>();
    let cursor = options.cursor;
    for (let page = 0; page < pages; page += 1) {
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) throw new DomainError("protocol", "OpenCode session pagination repeated a cursor");
        seenCursors.add(cursor);
      }
      const result = await this.listSessions({ ...options, cursor });
      sessions.push(...result.sessions);
      if (result.nextCursor === null) return sessions;
      cursor = result.nextCursor;
    }
    throw new DomainError("protocol", "OpenCode session pagination exceeded its page bound");
  }

  async listAllMessages(options: MessageListRequest & { readonly maxPages?: number }): Promise<ReadonlyArray<OpenCodeAssistantMessage>> {
    const pages = Math.max(1, Math.floor(options.maxPages ?? 10_000));
    const messages: OpenCodeAssistantMessage[] = [];
    const seenCursors = new Set<string>();
    let cursor = options.cursor;
    for (let page = 0; page < pages; page += 1) {
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) throw new DomainError("protocol", "OpenCode message pagination repeated a cursor");
        seenCursors.add(cursor);
      }
      const result = await this.listMessages({ ...options, cursor });
      messages.push(...result.messages);
      if (result.nextCursor === null) return messages;
      cursor = result.nextCursor;
    }
    throw new DomainError("protocol", "OpenCode message pagination exceeded its page bound");
  }
}

export function createOpenCodeTransport(options: OpenCodeTransportOptions): OpenCode2Transport {
  return new OpenCode2Transport(options);
}
