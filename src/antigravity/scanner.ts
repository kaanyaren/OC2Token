import { basename } from "node:path";
import { statSync } from "node:fs";
import { createRequire } from "node:module";

import { containsInstant, createUsageRecord, sumUsageRecords } from "../domain/index.js";
import { UsageRecordReducer } from "../accounting/reducer.js";
import {
  DomainError,
  cancellationError,
  isCancellationError,
  toCollectionError,
} from "../domain/index.js";
import type {
  CollectionRequest,
  CollectionResult,
  Coverage,
  CollectionError,
  UsageRecord,
  UsageBreakdown,
  UsageBreakdownsByWindow,
  UsageTotalsByWindow,
} from "../domain/index.js";

import { discoverAntigravityDatabases } from "./discovery.js";
import {
  antigravitySqliteCreatedAt,
  antigravitySqliteModel,
  antigravitySqliteResponseId,
  firstProtoField,
  parseProtoFields,
  protoFieldBytes,
  protoFieldPositiveInteger,
} from "./proto.js";

// SQLite driver lazy loading — mirrors codeburn loadDriver/isSqliteAvailable
let CachedDatabaseSync: typeof import("node:sqlite").DatabaseSync | null | undefined = undefined;
let loadAttempted = false;
let loadError: string | null = null;

function getDatabaseSync(): typeof import("node:sqlite").DatabaseSync | null {
  if (CachedDatabaseSync !== undefined) {
    return CachedDatabaseSync;
  }
  if (loadAttempted) {
    return CachedDatabaseSync ?? null;
  }
  loadAttempted = true;
  try {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("node:sqlite") as { DatabaseSync: typeof import("node:sqlite").DatabaseSync };
    CachedDatabaseSync = mod.DatabaseSync ?? null;
    loadError = null;
  } catch (error) {
    CachedDatabaseSync = null;
    loadError = error instanceof Error ? error.message : String(error);
  }
  return CachedDatabaseSync;
}

export function isSqliteAvailable(): boolean {
  return getDatabaseSync() !== null;
}

function getSqliteLoadError(): string {
  return loadError ?? "node:sqlite unavailable";
}

function isSqliteBusyError(error: unknown): boolean {
  const e = error as Record<string, unknown> | null;
  if (e === null || typeof e !== "object") {
    return false;
  }
  const code = typeof e.code === "string" ? e.code : "";
  const errcode = typeof e.errcode === "number" ? e.errcode : null;
  const message = [
    typeof e.message === "string" ? e.message : "",
    typeof (e as { errstr?: unknown }).errstr === "string" ? (e as { errstr: string }).errstr : "",
  ].join(" ");
  return (
    errcode === 5 ||
    errcode === 6 ||
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    /\bSQLITE_(BUSY|LOCKED)\b|database (?:is |table is )?locked/i.test(message)
  );
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    throw cancellationError(reason instanceof Error ? reason.message : undefined);
  }
}

function sortedErrors(errors: ReadonlyArray<CollectionError>): ReadonlyArray<CollectionError> {
  return [...errors].sort((a, b) =>
    (String(a.sessionID ?? "") + "\0" + a.code + "\0" + a.message).localeCompare(
      String(b.sessionID ?? "") + "\0" + b.code + "\0" + b.message,
    ),
  );
}

function normalizeDataBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (value !== null && typeof value === "object" && "buffer" in (value as Record<string, unknown>)) {
    // Node Buffer fallback
    try {
      const buf = value as Buffer;
      return new Uint8Array(buf.buffer ?? buf, (buf as unknown as { byteOffset?: number }).byteOffset ?? 0, buf.length ?? 0);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Native Antigravity SQLite scanner — no codeburn dependency.
 * Mirrors codeburn `buildCallFromSqliteGenMetadataRow` (dist/main.js:17240)
 * and surrounding DB open/query logic (dist/main.js:7688).
 */
export async function collectAntigravity(request: CollectionRequest): Promise<CollectionResult> {
  assertNotAborted(request.signal);

  if (request.windows.length === 0) {
    throw new DomainError("invalid-window", "Collection request must contain at least one usage window");
  }

  const dbFiles = discoverAntigravityDatabases();

  // Early exit if node:sqlite unavailable — matches T3 spec
  if (!isSqliteAvailable()) {
    assertNotAborted(request.signal);
    const emptyRecords: ReadonlyArray<UsageRecord> = [];
    const totalsByWindow: UsageTotalsByWindow = Object.fromEntries(
      request.windows.map((w) => [w.kind, sumUsageRecords(emptyRecords, w)]),
    );
    const coverage: Coverage = {
      complete: false,
      sessionsDiscovered: dbFiles.length,
      sessionsScanned: 0,
      sessionsSkipped: dbFiles.length > 0 ? dbFiles.length : 0,
      pagesRead: 0,
      jobsRetried: 0,
      provisionalMessages: 0,
      errors: [
        {
          code: "unknown",
          message: getSqliteLoadError(),
          retryable: false,
        },
      ],
    };
    return {
      capturedAt: new Date(request.capturedAt.getTime()),
      windows: request.windows.map((w) => ({
        ...w,
        from: new Date(w.from.getTime()),
        to: new Date(w.to.getTime()),
      })),
      source: "antigravity",
      records: emptyRecords,
      totalsByWindow,
      coverage,
    };
  }

  const mutable = {
    sessionsDiscovered: dbFiles.length,
    sessionsScanned: 0,
    sessionsSkipped: 0,
    pagesRead: 0,
    jobsRetried: 0,
    provisionalMessages: 0,
    errors: [] as CollectionError[],
  };

  const reducer = new UsageRecordReducer();

  if (dbFiles.length === 0) {
    assertNotAborted(request.signal);
    const records = reducer.records();
    const totalsByWindow: UsageTotalsByWindow = Object.fromEntries(
      request.windows.map((w) => [w.kind, sumUsageRecords(records, w)]),
    );
    const coverage: Coverage = {
      complete: true,
      sessionsDiscovered: 0,
      sessionsScanned: 0,
      sessionsSkipped: 0,
      pagesRead: 0,
      jobsRetried: 0,
      provisionalMessages: 0,
      errors: [],
    };
    return {
      capturedAt: new Date(request.capturedAt.getTime()),
      windows: request.windows.map((w) => ({
        ...w,
        from: new Date(w.from.getTime()),
        to: new Date(w.to.getTime()),
      })),
      source: "antigravity",
      records,
      totalsByWindow,
      coverage,
    };
  }

  const DatabaseSync = getDatabaseSync();
  // Should be non-null due to earlier check, but guard for race
  if (DatabaseSync === null) {
    const emptyRecords: ReadonlyArray<UsageRecord> = [];
    const totalsByWindow: UsageTotalsByWindow = Object.fromEntries(
      request.windows.map((w) => [w.kind, sumUsageRecords(emptyRecords, w)]),
    );
    const coverage: Coverage = {
      complete: false,
      sessionsDiscovered: dbFiles.length,
      sessionsScanned: 0,
      sessionsSkipped: dbFiles.length,
      pagesRead: 0,
      jobsRetried: 0,
      provisionalMessages: 0,
      errors: [{ code: "unknown", message: getSqliteLoadError(), retryable: false }],
    };
    return {
      capturedAt: new Date(request.capturedAt.getTime()),
      windows: request.windows.map((w) => ({
        ...w,
        from: new Date(w.from.getTime()),
        to: new Date(w.to.getTime()),
      })),
      source: "antigravity",
      records: emptyRecords,
      totalsByWindow,
      coverage,
    };
  }

  for (const filePath of dbFiles) {
    assertNotAborted(request.signal);

    const cascadeId = basename(filePath, ".db");
    // Fallback timestamp via file mtime (assignStableTimestamps behavior)
    let fallbackTimestampIso: string | undefined;
    let fallbackDate: Date | undefined;
    try {
      const stat = statSync(filePath);
      fallbackDate = new Date(stat.mtimeMs);
      fallbackTimestampIso = fallbackDate.toISOString();
    } catch {
      fallbackDate = undefined;
      fallbackTimestampIso = undefined;
    }

    let db: InstanceType<typeof DatabaseSync> | null = null;

    // Open readonly DB — pragma busy_timeout mirrors codeburn openDatabase
    try {
      db = new DatabaseSync(filePath, { readOnly: true });
      try {
        // Best effort; some sqlite builds lack exec
        (db as unknown as { exec?: (sql: string) => void }).exec?.("PRAGMA busy_timeout = 1000");
      } catch {
        // ignore pragma errors
      }
    } catch (error) {
      if (isCancellationError(error)) {
        throw cancellationError();
      }
      if (isSqliteBusyError(error)) {
        // Retry once
        let retried = false;
        try {
          // Small retry after busy; not sleeping to avoid latency
          db = new DatabaseSync(filePath, { readOnly: true });
          try {
            (db as unknown as { exec?: (sql: string) => void }).exec?.("PRAGMA busy_timeout = 1000");
          } catch {
            // ignore
          }
          retried = true;
        } catch (retryError) {
          if (isCancellationError(retryError)) {
            throw cancellationError();
          }
          mutable.sessionsSkipped += 1;
          mutable.errors.push(toCollectionError(retryError, "unknown", cascadeId));
          continue;
        }
        if (!retried) {
          mutable.sessionsSkipped += 1;
          mutable.errors.push(toCollectionError(error, "unknown", cascadeId));
          continue;
        }
        // fall through to query with retried db
      } else {
        mutable.sessionsSkipped += 1;
        mutable.errors.push(toCollectionError(error, "unknown", cascadeId));
        continue;
      }
    }

    if (db === null) {
      mutable.sessionsSkipped += 1;
      mutable.errors.push(toCollectionError(new Error("Failed to open database"), "unknown", cascadeId));
      continue;
    }

    let rows: Array<{ idx: number; data: unknown }>;
    try {
      const stmt = db.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx");
      // stmt.all returns rows; for readonly we pass no params
      rows = stmt.all() as Array<{ idx: number; data: unknown }>;
      mutable.pagesRead += 1;
    } catch (error) {
      if (isCancellationError(error)) {
        try {
          db.close();
        } catch {
          // ignore
        }
        throw cancellationError();
      }
      if (isSqliteBusyError(error)) {
        mutable.sessionsSkipped += 1;
        // retry once
        try {
          // Re-open and retry query once
          try {
            db.close();
          } catch {
            // ignore
          }
          const retryDb = new DatabaseSync(filePath, { readOnly: true });
          try {
            (retryDb as unknown as { exec?: (sql: string) => void }).exec?.("PRAGMA busy_timeout = 1000");
          } catch {
            // ignore
          }
          const retryStmt = retryDb.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx");
          rows = retryStmt.all() as Array<{ idx: number; data: unknown }>;
          mutable.jobsRetried += 1;
          mutable.pagesRead += 1;
          try {
            retryDb.close();
          } catch {
            // ignore
          }
          // continue to row processing with retry rows
          db = null; // already closed retryDb, prevent double close
        } catch (retryError) {
          if (isCancellationError(retryError)) {
            throw cancellationError();
          }
          mutable.errors.push(toCollectionError(retryError, "unknown", cascadeId));
          try {
            db?.close();
          } catch {
            // ignore
          }
          continue;
        }
      } else {
        mutable.sessionsSkipped += 1;
        mutable.errors.push(toCollectionError(error, "unknown", cascadeId));
        try {
          db?.close();
        } catch {
          // ignore
        }
        continue;
      }
    } finally {
      // For non-busy-retry path, close after query; for retry success we already handled.
      // We need to handle both cases: if db still open, close after row processing.
      // So defer close until after row loop for normal path.
    }

    // If we retried successfully, rows is already set and db is null (closed). Create a new db handle not needed.
    // For normal path, db is still open; we will close after processing.
    const shouldCloseDb = db !== null;

    // Process rows
    let fileHadRows = false;
    let fileHadError = false;
    try {
      for (const row of rows) {
        assertNotAborted(request.signal);

        const idx = typeof row.idx === "number" ? row.idx : Number(row.idx);
        const dataBytes = normalizeDataBytes(row.data);
        if (dataBytes === null) {
          continue;
        }

        const rootFields = parseProtoFields(dataBytes);
        const chatBytes = protoFieldBytes(firstProtoField(rootFields, 1));
        const chatFields = parseProtoFields(chatBytes ?? new Uint8Array());
        const usageBytes = protoFieldBytes(firstProtoField(chatFields, 4));
        const usageFields = parseProtoFields(usageBytes ?? new Uint8Array());

        if (usageFields.length === 0) {
          continue;
        }

        const inputTokens =
          protoFieldPositiveInteger(firstProtoField(usageFields, 2)) ||
          protoFieldPositiveInteger(firstProtoField(usageFields, 1));
        const totalOutputTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 3));
        let responseTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 9));
        let thinkingTokens = protoFieldPositiveInteger(firstProtoField(usageFields, 10));

        // Adjust logic mirrors codeburn buildCallFromSqliteGenMetadataRow:17255
        if (responseTokens === 0 && thinkingTokens === 0) {
          responseTokens = totalOutputTokens;
        } else if (totalOutputTokens > 0 && responseTokens + thinkingTokens !== totalOutputTokens) {
          const adjustedResponseTokens = totalOutputTokens - thinkingTokens;
          if (adjustedResponseTokens >= 0) {
            responseTokens = adjustedResponseTokens;
          }
        }

        if (inputTokens === 0 && totalOutputTokens === 0) {
          continue;
        }

        const responseId = antigravitySqliteResponseId(usageFields, String(idx));
        const model = antigravitySqliteModel(chatFields);

        let createdAt: Date | null = null;
        const timestampIso = antigravitySqliteCreatedAt(chatFields);
        if (timestampIso) {
          const parsed = new Date(timestampIso);
          if (!Number.isNaN(parsed.getTime())) {
            createdAt = parsed;
          }
        }
        if (createdAt === null && fallbackDate !== undefined && !Number.isNaN(fallbackDate.getTime())) {
          createdAt = new Date(fallbackDate.getTime());
        }
        if (createdAt === null) {
          // No usable timestamp — skip record but count as error?
          fileHadError = true;
          mutable.errors.push(
            toCollectionError(
              new DomainError("invalid-data", "Missing timestamp in gen_metadata row", { sessionID: cascadeId }),
              "invalid-data",
              cascadeId,
            ),
          );
          continue;
        }

        // Window filter — in-memory containsInstant
        const inWindow = request.windows.some((w) => containsInstant(w, createdAt!));
        if (!inWindow) {
          continue;
        }

        const deduplicationKey = `antigravity:${cascadeId}:${responseId}`;

        try {
          const record: UsageRecord = createUsageRecord({
            sessionID: cascadeId,
            messageID: responseId,
            createdAt,
            model,
            tokens: {
              input: inputTokens,
              output: responseTokens,
              reasoning: thinkingTokens,
              cacheRead: 0,
              cacheWrite: 0,
            },
            observedAt: new Date(request.capturedAt.getTime()),
            completeness: "final",
            provider: "antigravity",
            tokenRevision: deduplicationKey,
          });
          reducer.upsert(record);
          fileHadRows = true;
        } catch (error) {
          if (isCancellationError(error)) {
            throw cancellationError();
          }
          fileHadError = true;
          mutable.errors.push(toCollectionError(error, "invalid-data", cascadeId));
        }
      }
    } finally {
      if (shouldCloseDb) {
        try {
          db!.close();
        } catch {
          // ignore close errors; if busy, count as skipped
        }
      }
    }

    if (fileHadRows && !fileHadError) {
      mutable.sessionsScanned += 1;
    } else if (fileHadError) {
      mutable.sessionsSkipped += 1;
    } else {
      // No rows but successful query counts as scanned (empty db)
      mutable.sessionsScanned += 1;
    }
  }

  assertNotAborted(request.signal);

  const records = reducer.records();

  const totalsByWindow: UsageTotalsByWindow = Object.fromEntries(
    request.windows.map((w) => [w.kind, sumUsageRecords(records, w)]),
  );

  // Provider / model breakdowns per window (mirrors codex scanner)
  const providersMutable: Record<string, ReadonlyArray<UsageBreakdown>> = {};
  const modelsMutable: Record<string, ReadonlyArray<UsageBreakdown>> = {};
  const projectsMutable: Record<string, ReadonlyArray<UsageBreakdown>> = {};

  for (const w of request.windows) {
    const windowRecords = records.filter((r) => containsInstant(w, r.createdAt));
    if (windowRecords.length === 0) {
      continue;
    }
    const antigravityTotals = sumUsageRecords(windowRecords, w);
    providersMutable[w.kind] = [{ name: "antigravity", provider: "antigravity", totals: antigravityTotals }];

    const byModel = new Map<string, UsageRecord[]>();
    for (const r of windowRecords) {
      const key = r.model;
      const arr = byModel.get(key);
      if (arr === undefined) byModel.set(key, [r]);
      else arr.push(r);
    }
    const modelBreakdowns: UsageBreakdown[] = [];
    for (const [modelName, recs] of byModel.entries()) {
      const totals = sumUsageRecords(recs, w);
      modelBreakdowns.push({ name: modelName, totals });
    }
    modelBreakdowns.sort((a, b) => b.totals.recorded_total - a.totals.recorded_total);
    if (modelBreakdowns.length > 0) {
      modelsMutable[w.kind] = modelBreakdowns;
    }

    const byProject = new Map<string, UsageRecord[]>();
    for (const r of windowRecords) {
      if (r.project === undefined || r.project.trim().length === 0) continue;
      const key = r.project;
      const arr = byProject.get(key);
      if (arr === undefined) byProject.set(key, [r]);
      else arr.push(r);
    }
    if (byProject.size > 0) {
      const projectBreakdowns: UsageBreakdown[] = [];
      for (const [projName, recs] of byProject.entries()) {
        const totals = sumUsageRecords(recs, w);
        projectBreakdowns.push({ name: projName, totals });
      }
      projectBreakdowns.sort((a, b) => b.totals.recorded_total - a.totals.recorded_total || a.name.localeCompare(b.name));
      projectsMutable[w.kind] = projectBreakdowns;
    }
  }

  const providersByWindow: UsageBreakdownsByWindow = providersMutable;
  const modelsByWindow: UsageBreakdownsByWindow = modelsMutable;
  const projectsByWindow: UsageBreakdownsByWindow = projectsMutable;

  const finalCoverage: Coverage = {
    complete: mutable.errors.length === 0 && mutable.sessionsSkipped === 0,
    sessionsDiscovered: mutable.sessionsDiscovered,
    sessionsScanned: mutable.sessionsScanned,
    sessionsSkipped: mutable.sessionsSkipped,
    pagesRead: mutable.pagesRead,
    jobsRetried: mutable.jobsRetried,
    provisionalMessages: mutable.provisionalMessages,
    errors: sortedErrors(mutable.errors),
  };

  const maybeModels =
    Object.keys(modelsByWindow).length > 0
      ? { modelsByWindow, models: [...(modelsByWindow.week ?? modelsByWindow.day ?? modelsByWindow.hour ?? Object.values(modelsByWindow).flat())] }
      : {};
  const maybeProviders =
    Object.keys(providersByWindow).length > 0
      ? { providersByWindow, providers: [...(providersByWindow.week ?? providersByWindow.day ?? providersByWindow.hour ?? Object.values(providersByWindow).flat())] }
      : {};
  const maybeProjects =
    Object.keys(projectsByWindow).length > 0
      ? { projectsByWindow, projects: [...(projectsByWindow.week ?? projectsByWindow.day ?? projectsByWindow.hour ?? Object.values(projectsByWindow).flat())] }
      : {};

  return {
    capturedAt: new Date(request.capturedAt.getTime()),
    windows: request.windows.map((w) => ({
      ...w,
      from: new Date(w.from.getTime()),
      to: new Date(w.to.getTime()),
    })),
    source: "antigravity",
    records,
    totalsByWindow,
    ...maybeModels,
    ...maybeProviders,
    ...maybeProjects,
    coverage: finalCoverage,
  };
}
