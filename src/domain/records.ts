import { DomainError } from "./errors.js";
import { containsInstant, type UsageWindow } from "./windows.js";
import {
  parseTokenComponents,
  recorded_total,
  toUsageTotals,
  type TokenComponents,
  type UsageTotals,
} from "./tokens.js";

export type UsageRecordCompleteness = "final" | "provisional";

export interface UsageRecordInput {
  readonly sessionID: string;
  readonly messageID: string;
  readonly createdAt: Date;
  readonly model: string;
  readonly tokens: TokenComponents;
  readonly observedAt: Date;
  readonly completeness: UsageRecordCompleteness;
  /** Adapters may supply a provider revision; otherwise a deterministic value is derived. */
  readonly tokenRevision?: string;
}

/** Canonical normalized usage-bearing assistant message. */
export interface UsageRecord extends TokenComponents {
  /** Idempotency key: one OpenCode session plus one assistant message. */
  readonly key: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly createdAt: Date;
  readonly model: string;
  readonly recorded_total: number;
  readonly tokenRevision: string;
  readonly observedAt: Date;
  readonly completeness: UsageRecordCompleteness;
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError("invalid-usage-record", `${field} must not be empty`);
  }
}

function assertRecordID(value: string, field: string): void {
  assertNonEmpty(value, field);
  if (value.includes("/")) {
    throw new DomainError(
      "invalid-usage-record",
      `${field} must not contain '/' because it is part of the stable record key`,
    );
  }
}

function assertDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new DomainError("invalid-usage-record", `${field} must be a valid Date`);
  }
}

/**
 * The default revision is deliberately deterministic and content-addressed.
 * A later observation of the same message with different tokens therefore
 * replaces the old record instead of being added as a delta.
 */
export function tokenRevisionFor(
  tokens: TokenComponents,
  completeness: UsageRecordCompleteness,
): string {
  const normalized = parseTokenComponents(tokens);
  return [
    "v1",
    normalized.input,
    normalized.output,
    normalized.reasoning,
    normalized.cacheRead,
    normalized.cacheWrite,
    completeness,
  ].join(":");
}

/** Return the stable idempotency key used by cache reducers and retries. */
export function usageRecordKey(sessionID: string, messageID: string): string {
  assertRecordID(sessionID, "sessionID");
  assertRecordID(messageID, "messageID");
  return `${sessionID}/${messageID}`;
}

export const stableRecordKey = usageRecordKey;

export function createUsageRecord(input: UsageRecordInput): UsageRecord {
  assertRecordID(input.sessionID, "sessionID");
  assertRecordID(input.messageID, "messageID");
  assertNonEmpty(input.model, "model");
  if (input.completeness !== "final" && input.completeness !== "provisional") {
    throw new DomainError(
      "invalid-usage-record",
      "completeness must be 'final' or 'provisional'",
    );
  }
  assertDate(input.createdAt, "createdAt");
  assertDate(input.observedAt, "observedAt");

  const tokens = parseTokenComponents(input.tokens);
  const recordedTotal = recorded_total(tokens);
  const tokenRevision = input.tokenRevision ?? tokenRevisionFor(tokens, input.completeness);
  assertNonEmpty(tokenRevision, "tokenRevision");

  return {
    key: usageRecordKey(input.sessionID, input.messageID),
    sessionID: input.sessionID,
    messageID: input.messageID,
    createdAt: new Date(input.createdAt.getTime()),
    model: input.model,
    ...tokens,
    recorded_total: recordedTotal,
    tokenRevision,
    observedAt: new Date(input.observedAt.getTime()),
    completeness: input.completeness,
  };
}

export interface SumUsageRecordsOptions {
  /** Provisional messages are excluded by default until a caller opts in. */
  readonly includeProvisional?: boolean;
}

type MutableTokenComponents = {
  -readonly [Name in keyof TokenComponents]: TokenComponents[Name];
};

/** Sum canonical records in a half-open window without mutating the records. */
export function sumUsageRecords(
  records: ReadonlyArray<UsageRecord>,
  window: UsageWindow,
  options: SumUsageRecordsOptions = {},
): UsageTotals {
  const totals: MutableTokenComponents = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };

  for (const record of records) {
    if (record.completeness === "provisional" && !options.includeProvisional) {
      continue;
    }
    if (!containsInstant(window, record.createdAt)) {
      continue;
    }

    for (const name of ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const) {
      const next = totals[name] + record[name];
      if (!Number.isSafeInteger(next)) {
        throw new DomainError(
          "invalid-token-components",
          `Summing ${name} exceeds the safe integer range`,
        );
      }
      totals[name] = next;
    }
  }

  return toUsageTotals(totals);
}
