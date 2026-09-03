import { createHash } from "node:crypto";

import { DomainError } from "../domain/errors.js";
import {
  parseTokenComponents,
  recorded_total,
  type ProviderKind,
  type TokenComponents,
} from "../domain/index.js";
import {
  CACHE_FORMAT,
  CURRENT_CACHE_SCHEMA_VERSION,
  RECORDS_FORMAT,
  type CacheManifest,
  type UsageRecord,
} from "./types.js";

export interface PersistedRecord {
  readonly key: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly createdAt: string;
  readonly model: string;
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly recorded_total: number;
  readonly tokenRevision: string;
  readonly observedAt: string;
  readonly completeness: "final" | "provisional";
  readonly provider: ProviderKind;
  readonly project?: string;
}

export interface RecordsDocument {
  readonly format: typeof RECORDS_FORMAT;
  readonly schemaVersion: number;
  readonly records: readonly PersistedRecord[];
}

export interface ManifestDocument extends CacheManifest {
  readonly snapshot: unknown;
}

const FORBIDDEN_KEY = /(?:prompt|tool.?input|tool.?output|api.?key|authorization|password|secret|session.?title|session.?name|raw.?content)/i;
// NOTE (slash contract): SAFE_ID intentionally permits "/" so the cache can
// persist raw keys such as "session/message" and project paths. The domain
// layer is stricter: assertRecordID in src/domain/records.ts rejects "/" in
// sessionID/messageID because "/" joins the stable record key. Scanners must
// sanitize IDs (replace "/" before createUsageRecord); the cache preserves
// whatever it is given and domain validation happens at that boundary.
// recorded_total is always recomputed from the five validated components and
// a caller-supplied total that disagrees is rejected, never trusted.
const SAFE_ID = /^[^\u0000-\u001f]{1,512}$/;
const SAFE_REVISION = /^[a-zA-Z0-9._:-]{1,256}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string, cause?: unknown): never {
  throw new DomainError("cache-corrupt", message, { cause });
}

function stringField(value: unknown, name: string, pattern = SAFE_ID): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${name} must be a bounded string`);
  }
  return value;
}

function dateField(value: unknown, name: string): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    fail(`${name} must be a valid date`);
  }
  return date.toISOString();
}

function recordField(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function recordFromUnknown(value: unknown, index: number): PersistedRecord {
  if (!isRecord(value)) {
    fail(`records[${index}] must be an object`);
  }

  const components: TokenComponents = parseTokenComponents(value);
  const sessionID = stringField(value.sessionID, `records[${index}].sessionID`);
  const messageID = stringField(value.messageID, `records[${index}].messageID`);
  const key = stringField(value.key ?? `${sessionID}/${messageID}`, `records[${index}].key`);
  const model = stringField(value.model ?? "unknown", `records[${index}].model`);
  const tokenRevision = stringField(
    value.tokenRevision ?? revisionFor(components, value.completeness),
    `records[${index}].tokenRevision`,
    SAFE_REVISION,
  );
  const completeness = value.completeness ?? "final";
  if (completeness !== "final" && completeness !== "provisional") {
    fail(`records[${index}].completeness must be final or provisional`);
  }
  const rawProvider = value.provider ?? "opencode";
  if (rawProvider !== "opencode" && rawProvider !== "codex" && rawProvider !== "antigravity") {
    fail(`records[${index}].provider must be one of opencode, codex, antigravity`);
  }
  const provider = rawProvider as ProviderKind;

  // Project field: optional, may contain slashes (paths). Validate length and control chars separately.
  let project: string | undefined;
  if (value.project !== undefined && value.project !== null) {
    if (typeof value.project !== "string") {
      fail(`records[${index}].project must be a string when present`);
    }
    const trimmed = value.project.trim();
    if (trimmed.length === 0) {
      project = undefined;
    } else {
      if (trimmed.length > 1024 || /[\u0000-\u001f]/.test(trimmed)) {
        fail(`records[${index}].project must be 1..1024 chars without control characters`);
      }
      project = trimmed;
    }
  }

  const normalized = {
    key,
    sessionID,
    messageID,
    createdAt: dateField(value.createdAt, `records[${index}].createdAt`),
    model,
    ...components,
    recorded_total: recorded_total(components),
    tokenRevision,
    observedAt: dateField(value.observedAt ?? new Date(), `records[${index}].observedAt`),
    completeness,
    provider,
    ...(project === undefined ? {} : { project }),
  } satisfies PersistedRecord;

  // A caller-provided total is metadata only. It is never trusted or written;
  // the normalized sum is recomputed from the five validated components.
  if ("recorded_total" in value && value.recorded_total !== normalized.recorded_total) {
    fail(`records[${index}].recorded_total does not match its components`);
  }
  return normalized;
}

function revisionFor(components: TokenComponents, completeness: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ ...components, completeness }))
    .digest("hex");
}

/** Convert a domain record to a whitelist-only JSON record. */
export function normalizeRecord(record: UsageRecord): PersistedRecord {
  return recordFromUnknown(record, 0);
}

export function toDomainRecord(record: PersistedRecord): UsageRecord {
  // The domain record intentionally contains Date values. The cast is limited
  // to this boundary; all fields were validated by parseRecordsDocument first.
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    observedAt: new Date(record.observedAt),
  } as unknown as UsageRecord;
}

export function serializeRecords(records: readonly UsageRecord[]): string {
  const normalized = records.map(normalizeRecord);
  const document: RecordsDocument = {
    format: RECORDS_FORMAT,
    schemaVersion: CURRENT_CACHE_SCHEMA_VERSION,
    records: normalized,
  };
  return `${JSON.stringify(document)}\n`;
}

export interface MigratedDocument<T> {
  readonly value: T;
  readonly migrated: boolean;
}

function schemaVersion(value: Record<string, unknown>): number {
  const version = value.schemaVersion ?? value.version ?? 0;
  if (!Number.isSafeInteger(version) || (version as number) < 0) {
    fail("schemaVersion must be a non-negative integer");
  }
  return version as number;
}

/** Migrate the small v0 record shape used by early development snapshots. */
export function migrateRecordsDocument(value: unknown): MigratedDocument<RecordsDocument> {
  if (!isRecord(value)) {
    fail("records document must be an object");
  }
  const version = schemaVersion(value);
  if (version > CURRENT_CACHE_SCHEMA_VERSION) {
    throw new DomainError("cache-corrupt", "records document uses a future schema");
  }

  const rawRecords = value.records ?? value.items;
  if (!Array.isArray(rawRecords)) {
    fail("records document must contain a records array");
  }
  const records = rawRecords.map((record, index) => {
    if (version === 0 && isRecord(record)) {
      const legacyTokens = isRecord(record.tokens) ? record.tokens : {};
      return {
        ...record,
        ...legacyTokens,
        createdAt: record.createdAt ?? record.timestamp,
        observedAt: record.observedAt ?? record.observed,
        cacheRead: record.cacheRead ?? (isRecord(record.cache) ? record.cache.read : undefined),
        cacheWrite: record.cacheWrite ?? (isRecord(record.cache) ? record.cache.write : undefined),
      };
    }
    return record;
  }).map(recordFromUnknown);

  return {
    migrated: version !== CURRENT_CACHE_SCHEMA_VERSION || value.format !== RECORDS_FORMAT,
    value: { format: RECORDS_FORMAT, schemaVersion: CURRENT_CACHE_SCHEMA_VERSION, records },
  };
}

function safeSnapshotValue(value: unknown, depth = 0): unknown {
  if (depth > 12) {
    fail("snapshot metadata is too deeply nested");
  }
  if (value instanceof Date) {
    return { $oc2Date: dateField(value, "snapshot date") };
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && value.length > 8192) {
      fail("snapshot metadata string is too large");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      fail("snapshot metadata number must be a safe integer");
    }
    return value;
  }
  if (Array.isArray(value)) {
    // Large histories embed thousands of records in the manifest snapshot.
    // A 4096 cap turned large *valid* snapshots into cache_unavailable; the
    // cap is now 1M entries so legitimate histories persist while still
    // bounding hostile/host-corrupt documents from exhausting memory.
    if (value.length > 1_000_000) {
      fail("snapshot metadata array is too large");
    }
    return value.map((entry) => safeSnapshotValue(entry, depth + 1));
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) {
        continue;
      }
      if (FORBIDDEN_KEY.test(key) || key === "content" || key === "parts" || key === "title") {
        continue;
      }
      result[key] = safeSnapshotValue(entry, depth + 1);
    }
    return result;
  }
  fail("snapshot metadata contains an unsupported value");
}

export function sanitizeSnapshot(snapshot: unknown): unknown {
  return safeSnapshotValue(snapshot);
}

function decodeSnapshotValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeSnapshotValue);
  if (!isRecord(value)) return value;
  if (Object.keys(value).length === 1 && typeof value.$oc2Date === "string") {
    return new Date(value.$oc2Date);
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeSnapshotValue(entry)]));
}

export function deserializeSnapshot(value: unknown, records: readonly UsageRecord[]): unknown {
  const decoded = decodeSnapshotValue(value);
  if (isRecord(decoded) && "records" in decoded) {
    return { ...decoded, records };
  }
  return decoded;
}

export function serializeSnapshot(snapshot: unknown): unknown {
  return sanitizeSnapshot(snapshot);
}

export function sha256(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

function safeRecordFile(value: unknown): string {
  if (typeof value !== "string" || !/^records-[a-zA-Z0-9._-]+\.json$/.test(value)) {
    fail("manifest recordFile is not a safe records filename");
  }
  return value;
}

export function migrateManifestDocument(value: unknown): MigratedDocument<ManifestDocument> {
  if (!isRecord(value)) {
    fail("manifest must be an object");
  }
  const version = schemaVersion(value);
  if (version > CURRENT_CACHE_SCHEMA_VERSION) {
    throw new DomainError("cache-corrupt", "manifest uses a future schema");
  }
  const source = (version === 0 && isRecord(value.snapshotData) ? value.snapshotData : value.snapshot) ?? {};
  const recordFile = value.recordFile ?? value.recordsFile;
  const generation = value.generation ?? 0;
  if (!Number.isSafeInteger(generation) || (generation as number) < 0) {
    fail("manifest generation must be a non-negative integer");
  }
  const recordBytes = value.recordBytes ?? value.bytes;
  if (!Number.isSafeInteger(recordBytes) || (recordBytes as number) < 0) {
    fail("manifest recordBytes must be a non-negative integer");
  }
  const recordSha256 = stringField(value.recordSha256 ?? value.sha256, "manifest recordSha256", /^[a-f0-9]{64}$/i);
  const createdAt = dateField(value.createdAt ?? value.created ?? new Date(0), "manifest createdAt");
  const complete = value.complete ?? (version === 0 ? true : undefined);
  if (complete !== true) {
    fail("manifest is incomplete");
  }

  let providerFingerprints: Record<ProviderKind, string> | undefined;
  if (isRecord(value.providerFingerprints)) {
    const fingerprints: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value.providerFingerprints)) {
      if (
        (key === "opencode" || key === "codex" || key === "antigravity") &&
        typeof entry === "string" &&
        entry.length > 0 &&
        entry.length <= 512 &&
        /^[a-zA-Z0-9._:-]{1,256}$/.test(entry)
      ) {
        fingerprints[key] = entry;
      }
    }
    if (Object.keys(fingerprints).length > 0) {
      providerFingerprints = fingerprints as Record<ProviderKind, string>;
    }
  }

  const manifest: ManifestDocument = {
    format: CACHE_FORMAT,
    schemaVersion: CURRENT_CACHE_SCHEMA_VERSION,
    manifestVersion: Number.isSafeInteger(value.manifestVersion) ? value.manifestVersion as number : 1,
    complete: true,
    generation: generation as number,
    createdAt,
    recordFile: safeRecordFile(recordFile),
    recordBytes: recordBytes as number,
    recordSha256,
    snapshot: sanitizeSnapshot(source),
    ...(providerFingerprints ? { providerFingerprints } : {}),
  };
  return {
    value: manifest,
    migrated:
      version !== CURRENT_CACHE_SCHEMA_VERSION ||
      value.format !== CACHE_FORMAT ||
      (value.providerFingerprints !== undefined && providerFingerprints === undefined),
  };
}

export function parseRecords(contents: string): MigratedDocument<RecordsDocument> {
  try {
    return migrateRecordsDocument(JSON.parse(contents) as unknown);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    fail("records JSON is invalid", error);
  }
}

export function parseManifest(contents: string): MigratedDocument<ManifestDocument> {
  try {
    return migrateManifestDocument(JSON.parse(contents) as unknown);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    fail("manifest JSON is invalid", error);
  }
}
