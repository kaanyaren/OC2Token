import type { UsageTotals } from "../domain/index.js";
import {
  type UsageRecord,
  sumUsageRecords,
  type UsageWindow,
} from "../domain/index.js";

function compareRevision(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  // Explicit numeric revisions are common in test transports and are the only
  // safe way to compare revisions such as 9 and 10 lexically.
  const leftNumber = /(?:^|:)(?:v)?(\d+)$/.exec(left)?.[1];
  const rightNumber = /(?:^|:)(?:v)?(\d+)$/.exec(right)?.[1];
  if (leftNumber !== undefined && rightNumber !== undefined) {
    const difference = Number(leftNumber) - Number(rightNumber);
    if (difference !== 0) {
      return difference;
    }
  }

  const leftScan = /^scan:(\d+):/.exec(left)?.[1];
  const rightScan = /^scan:(\d+):/.exec(right)?.[1];
  if (leftScan !== undefined && rightScan !== undefined) {
    const difference = Number(leftScan) - Number(rightScan);
    if (difference !== 0) return difference;
  }

  return left < right ? -1 : 1;
}

/**
 * A deterministic, synchronous reducer for usage records.
 *
 * Workers never mutate this reducer while they are reading pages. Callers can
 * feed records in any completion order and the winner is selected by observed
 * time, revision, and finally completeness, rather than arrival order.
 */
export class UsageRecordReducer {
  private readonly byKey = new Map<string, UsageRecord>();

  upsert(record: UsageRecord): boolean {
    const previous = this.byKey.get(record.key);
    if (previous === undefined || compareFreshness(record, previous) > 0) {
      this.byKey.set(record.key, record);
      return true;
    }
    return false;
  }

  upsertMany(records: ReadonlyArray<UsageRecord>): void {
    for (const record of records) {
      this.upsert(record);
    }
  }

  get size(): number {
    return this.byKey.size;
  }

  get(key: string): UsageRecord | undefined {
    return this.byKey.get(key);
  }

  records(): ReadonlyArray<UsageRecord> {
    return [...this.byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
  }

  totals(window: UsageWindow, includeProvisional = false): UsageTotals {
    return sumUsageRecords(this.records(), window, { includeProvisional });
  }
}

export function compareFreshness(left: UsageRecord, right: UsageRecord): number {
  const observedDifference = left.observedAt.getTime() - right.observedAt.getTime();
  if (observedDifference !== 0) {
    return observedDifference;
  }

  const revisionDifference = compareRevision(left.tokenRevision, right.tokenRevision);
  if (revisionDifference !== 0) {
    return revisionDifference;
  }

  // A final observation supersedes a provisional observation at the same
  // revision. This matters when a streaming message settles in one refresh.
  if (left.completeness !== right.completeness) {
    return left.completeness === "final" ? 1 : -1;
  }

  // Identical revisions should be byte-equivalent for accounting purposes. A
  // stable key tie-break keeps the comparator total without using arrival order.
  return left.key.localeCompare(right.key);
}

export function reduceUsageRecords(
  records: ReadonlyArray<UsageRecord>,
): ReadonlyArray<UsageRecord> {
  const reducer = new UsageRecordReducer();
  reducer.upsertMany(records);
  return reducer.records();
}
