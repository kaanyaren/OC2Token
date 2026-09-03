import type {
  CollectionError,
  CollectionRequest,
  CollectionResult,
  Coverage,
  MessageListRequest,
  MessagePage as DomainMessagePage,
  OpenCodeAssistantMessage,
  OpenCodeSession,
  OpenCodeTransport,
  SessionListRequest,
  SessionPage as DomainSessionPage,
  UsageWindow,
} from "../domain/index.js";

export type {
  CollectionError,
  CollectionRequest,
  CollectionResult,
  Coverage,
  MessageListRequest as ListMessagesRequest,
  OpenCodeAssistantMessage,
  OpenCodeSession,
  OpenCodeTransport,
  SessionListRequest as ListSessionsRequest,
  UsageWindow,
};

export interface UsageInterval {
  readonly from: Date;
  readonly to: Date;
}

/**
 * The collector accepts the normalized domain DTOs from the OpenCode adapter,
 * while retaining optional raw aliases for deterministic transport fixtures.
 */
export interface AssistantMessage {
  readonly sessionID?: string;
  readonly id?: string;
  readonly messageID?: string;
  readonly type?: string;
  readonly role?: string;
  readonly time?: {
    readonly created?: Date | number | string;
    readonly completed?: Date | number | string;
    readonly [key: string]: unknown;
  };
  readonly createdAt?: Date | number | string;
  readonly model?: string | {
    readonly providerID?: string;
    readonly id?: string;
    readonly [key: string]: unknown;
  };
  readonly tokens?: OpenCodeAssistantMessage["tokens"] | null;
  readonly tokenRevision?: string | number;
  readonly revision?: string | number;
  readonly version?: string | number;
  readonly provisional?: boolean;
  readonly status?: string;
  readonly finish?: string;
  readonly [key: string]: unknown;
}

export interface SessionSummary extends Partial<OpenCodeSession> {
  readonly id?: string;
  readonly sessionID?: string;
  readonly parentID?: string | null;
  readonly [key: string]: unknown;
}

export type SessionPage = DomainSessionPage;
export type MessagePage = DomainMessagePage;

export interface CursorEnvelope {
  readonly next?: string | null;
  readonly [key: string]: unknown;
}

export interface CollectorOptions {
  readonly pageLimit?: number;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly maxWorkers?: number;
  /**
   * Maximum paginated pages read per list (session discovery per parent, and
   * messages per session). Bounds infinite cursor loops; exceeded bounds are
   * reported as protocol coverage errors, not fatal throws.
   */
  readonly maxPages?: number;
  /** Maximum sessions held from discovery before scanning starts. */
  readonly maxSessions?: number;
}

export function intervalUnion(
  windows: ReadonlyArray<UsageWindow | UsageInterval>,
): UsageInterval {
  if (windows.length === 0) {
    throw new RangeError("At least one interval is required");
  }

  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const interval of windows) {
    const start = interval.from.getTime();
    const end = interval.to.getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      throw new RangeError("Every interval must have valid from < to instants");
    }
    from = Math.min(from, start);
    to = Math.max(to, end);
  }
  return { from: new Date(from), to: new Date(to) };
}
