import { join, resolve } from "node:path";

import { DomainError } from "../domain/errors.js";
import type {
  SnapshotStore,
  SnapshotStoreCommitOptions,
  SnapshotStoreReadOptions,
} from "../domain/index.js";
import { CacheLock, type CacheLockDependencies } from "./lock.js";
import { nodeCacheFileSystem, systemCacheClock, systemCacheProcess, systemCacheRandom } from "./filesystem.js";
import {
  CACHE_FORMAT,
  CURRENT_CACHE_SCHEMA_VERSION,
  MANIFEST_FILE_NAME,
  type CacheClock,
  type CacheCommitResult,
  type CacheFileSystem,
  type CacheManifest,
  type CacheProcess,
  type CacheRandom,
  type CacheReadResult,
  type CacheStoreOptions,
  type OrphanRecoveryResult,
  type StoredSnapshot,
  type UsageRecord,
} from "./types.js";
import {
  deserializeSnapshot,
  migrateManifestDocument,
  normalizeRecord,
  parseManifest,
  parseRecords,
  sanitizeSnapshot,
  serializeRecords,
  sha256,
  toDomainRecord,
  type PersistedRecord,
} from "./schema.js";

const TEMP_PREFIX = ".oc2token-";
const TEMP_SUFFIX = ".tmp";

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function missing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isFutureSchema(error: unknown): boolean {
  return error instanceof DomainError && /future schema/i.test(error.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotGeneration(snapshot: unknown): number {
  if (isRecord(snapshot) && Number.isSafeInteger(snapshot.generation) && (snapshot.generation as number) >= 0) {
    return snapshot.generation as number;
  }
  return 0;
}

function clockNow(clock: CacheClock): Date {
  const value = clock.now?.() ?? clock.wallNow?.();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new DomainError("invalid-date", "cache clock must return a valid Date");
  }
  return value;
}

function recordsFromSnapshot(snapshot: unknown): readonly UsageRecord[] {
  if (isRecord(snapshot) && Array.isArray(snapshot.records)) {
    return snapshot.records as UsageRecord[];
  }
  return [];
}

function normalizeRecords(records: readonly UsageRecord[]): readonly PersistedRecord[] {
  return records.map((record) => normalizeRecord(record));
}

async function quietUnlink(fs: CacheFileSystem, path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

export class NormalizedCacheStore implements SnapshotStore {
  readonly directory: string;
  readonly manifestPath: string;

  private readonly fs: CacheFileSystem;
  private readonly clock: CacheClock;
  private readonly process: CacheProcess;
  private readonly random: CacheRandom;
  private readonly lock: CacheLock;
  private readonly recoverOrphans: boolean;
  private static sequence = 0;

  // Chains are process-wide so two store instances targeting the same path do
  // not race even when their callers are otherwise unrelated.
  private static readonly commitChains = new Map<string, Promise<unknown>>();

  constructor(directory: string, dependencies?: CacheStoreOptions);
  constructor(options: CacheStoreOptions);
  constructor(directoryOrOptions: string | CacheStoreOptions, dependencies: CacheStoreOptions = {}) {
    const options = typeof directoryOrOptions === "string"
      ? { ...dependencies, directory: directoryOrOptions }
      : directoryOrOptions;
    const directory = options.directory ?? options.rootDir;
    if (!directory) {
      throw new DomainError("cache-unavailable", "A cache directory is required");
    }

    this.directory = resolve(directory);
    this.manifestPath = join(this.directory, MANIFEST_FILE_NAME);
    this.fs = options.fs ?? nodeCacheFileSystem;
    this.clock = options.clock ?? systemCacheClock;
    this.process = options.process ?? systemCacheProcess;
    this.random = options.random ?? systemCacheRandom;
    this.recoverOrphans = options.recoverOrphans ?? true;
    const lockDependencies: CacheLockDependencies = {
      fs: this.fs,
      clock: this.clock,
      process: this.process,
      random: this.random,
      staleLockMs: options.staleLockMs,
    };
    this.lock = new CacheLock(this.directory, lockDependencies);
  }

  private async ensureDirectory(): Promise<void> {
    await this.fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  private nextName(kind: string, generation = 0): string {
    NormalizedCacheStore.sequence += 1;
    const owner = this.random.uuid().replace(/[^a-zA-Z0-9-]/g, "");
    return `${kind}-${generation}-${this.process.pid}-${owner}-${NormalizedCacheStore.sequence}`;
  }

  private async syncDirectory(): Promise<void> {
    // Directory fsync is necessary for rename durability on POSIX. Some fake
    // filesystems do not model directory handles, so this operation is best
    // effort and can be replaced by a test adapter.
    try {
      const directoryHandle = await this.fs.open(this.directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (errorCode(error) === "EISDIR" || errorCode(error) === "EINVAL" || errorCode(error) === "ENOTSUP") {
        return;
      }
      throw error;
    }
  }

  private async writeUniqueAndRename(contents: string, target: string, tempKind: string): Promise<void> {
    const temp = join(this.directory, `${TEMP_PREFIX}${this.nextName(tempKind)}${TEMP_SUFFIX}`);
    let handle;
    try {
      handle = await this.fs.open(temp, "wx", 0o600);
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.fs.rename(temp, target);
      await this.syncDirectory();
    } catch (error) {
      await quietUnlink(this.fs, temp);
      throw error;
    }
  }

  private async currentManifestVersion(): Promise<number> {
    try {
      const contents = await this.fs.readFile(this.manifestPath, "utf8");
      const parsed = migrateManifestDocument(JSON.parse(contents) as unknown);
      return parsed.value.manifestVersion;
    } catch {
      return 0;
    }
  }

  /** Remove only OC2Token's own temporary files, never arbitrary cache files. */
  async recoverOrphanTemps(): Promise<OrphanRecoveryResult> {
    return this.recoverOrphanTempsInternal(false);
  }

  private async recoverOrphanTempsInternal(underOwnedLock: boolean): Promise<OrphanRecoveryResult> {
    const removed: string[] = [];
    const skipped: string[] = [];
    const errors: { file: string; error: unknown }[] = [];
    let entries: readonly string[];
    try {
      entries = await this.fs.readdir(this.directory);
    } catch (error) {
      if (missing(error)) return { removed, skipped, errors };
      return { removed, skipped, errors: [{ file: this.directory, error }] };
    }

    if (!underOwnedLock) {
      try {
        await this.fs.stat(this.lock.lockPath);
        // An active writer may still own one of the temp files. Leave all
        // temps untouched until its lock is gone.
        return {
          removed,
          skipped: entries.filter((entry) => this.isTemp(entry)),
          errors,
        };
      } catch (error) {
        if (!missing(error)) {
          return { removed, skipped, errors: [{ file: this.lock.lockPath, error }] };
        }
      }
    }

    for (const entry of entries) {
      if (!this.isTemp(entry)) continue;
      try {
        await this.fs.unlink(join(this.directory, entry));
        removed.push(entry);
      } catch (error) {
        if (missing(error)) {
          skipped.push(entry);
        } else {
          errors.push({ file: entry, error });
        }
      }
    }
    return { removed, skipped, errors };
  }

  private isTemp(entry: string): boolean {
    return entry.startsWith(TEMP_PREFIX) && entry.endsWith(TEMP_SUFFIX);
  }

  async readDetailed(): Promise<CacheReadResult> {
    if (this.recoverOrphans) {
      await this.recoverOrphanTemps();
    }

    let manifestContents: string;
    try {
      manifestContents = await this.fs.readFile(this.manifestPath, "utf8");
    } catch (error) {
      if (missing(error)) return { status: "empty" };
      return { status: "unavailable", reason: "cache_unavailable", stale: true, error };
    }

    let parsedManifest;
    try {
      parsedManifest = parseManifest(manifestContents);
    } catch (error) {
      return {
        status: "unavailable",
        reason: isFutureSchema(error) ? "future_schema" : "cache_corrupt",
        stale: true,
        error,
      };
    }

    const manifest = parsedManifest.value;
    let recordsContents: string;
    try {
      recordsContents = await this.fs.readFile(join(this.directory, manifest.recordFile), "utf8");
    } catch (error) {
      return { status: "unavailable", reason: "cache_corrupt", stale: true, error };
    }
    if (Buffer.byteLength(recordsContents, "utf8") !== manifest.recordBytes || sha256(recordsContents) !== manifest.recordSha256) {
      return {
        status: "unavailable",
        reason: "cache_corrupt",
        stale: true,
        error: new DomainError("cache-corrupt", "The cache record file failed manifest integrity checks"),
      };
    }

    let parsedRecords;
    try {
      parsedRecords = parseRecords(recordsContents);
    } catch (error) {
      return {
        status: "unavailable",
        reason: isFutureSchema(error) ? "future_schema" : "cache_corrupt",
        stale: true,
        error,
      };
    }

    const records = parsedRecords.value.records.map(toDomainRecord);
    return {
      status: "available",
      snapshot: deserializeSnapshot(manifest.snapshot, records) as StoredSnapshot,
      records,
      manifest,
      migrated: parsedManifest.migrated || parsedRecords.migrated,
    };
  }

  async read(options?: SnapshotStoreReadOptions): Promise<StoredSnapshot | null> {
    if (options?.signal?.aborted) {
      throw new DomainError("cancelled", "The cache read was cancelled");
    }
    const result = await this.readDetailed();
    return result.status === "available" ? result.snapshot : null;
  }

  private async commitNormalized(
    snapshot: StoredSnapshot,
    records: readonly UsageRecord[],
  ): Promise<CacheCommitResult> {
    try {
      await this.ensureDirectory();
    } catch (error) {
      return { status: "cache_unavailable", snapshot, records, error };
    }

    let lockResult;
    try {
      lockResult = await this.lock.tryAcquire();
    } catch (error) {
      return { status: "cache_unavailable", snapshot, records, error };
    }
    if (lockResult.status === "busy") {
      return { status: "cache_busy", snapshot, records, owner: lockResult.owner };
    }

    try {
      // We hold the lock, so no other process can be writing a temp file.
      await this.recoverOrphanTempsInternal(true);
      const recordsContents = serializeRecords(records);
      const generation = snapshotGeneration(snapshot);
      const recordFile = `records-${generation}-${this.nextName("record")}.json`;
      await this.writeUniqueAndRename(recordsContents, join(this.directory, recordFile), "records");

      const manifest: CacheManifest = {
        format: CACHE_FORMAT,
        schemaVersion: CURRENT_CACHE_SCHEMA_VERSION,
        manifestVersion: (await this.currentManifestVersion()) + 1,
        complete: true,
        generation,
        createdAt: clockNow(this.clock).toISOString(),
        recordFile,
        recordBytes: Buffer.byteLength(recordsContents, "utf8"),
        recordSha256: sha256(recordsContents),
        snapshot: sanitizeSnapshot(snapshot),
      };
      const manifestContents = `${JSON.stringify(manifest)}\n`;
      await this.writeUniqueAndRename(manifestContents, this.manifestPath, "manifest");

      const normalizedRecords = records.map((record) => toDomainRecord(normalizeRecord(record)));
      return { status: "committed", snapshot, records: normalizedRecords, manifest, recordFile };
    } catch (error) {
      return { status: "cache_unavailable", snapshot, records, error };
    } finally {
      await lockResult.release();
    }
  }

  /**
   * Commit is non-blocking across processes: a held lock returns cache_busy and
   * leaves the caller's correct in-memory snapshot untouched. Calls in this
   * process are serialized for the complete record+manifest publication.
   */
  async commitDetailed(snapshot: StoredSnapshot, records = recordsFromSnapshot(snapshot)): Promise<CacheCommitResult> {
    const normalized = normalizeRecords(records);
    const previous = NormalizedCacheStore.commitChains.get(this.directory) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.commitNormalized(snapshot, records));
    NormalizedCacheStore.commitChains.set(this.directory, current);
    try {
      return await current;
    } finally {
      if (NormalizedCacheStore.commitChains.get(this.directory) === current) {
        NormalizedCacheStore.commitChains.delete(this.directory);
      }
    }
  }

  async commit(snapshot: StoredSnapshot, options?: SnapshotStoreCommitOptions): Promise<void> {
    if (options?.signal?.aborted) {
      throw new DomainError("cancelled", "The cache commit was cancelled");
    }
    const result = await this.commitDetailed(snapshot);
    if (result.status === "cache_busy") {
      throw new DomainError("cache-busy", "Another OC2Token process owns the cache lock", {
        retryable: true,
      });
    }
    if (result.status === "cache_unavailable") {
      throw new DomainError("cache-unavailable", "The cache commit could not be published", {
        cause: result.error,
        retryable: true,
      });
    }
  }
}

export const FileCacheStore = NormalizedCacheStore;
export const SnapshotCacheStore = NormalizedCacheStore;

/** Domain-facing facade: detailed callers can inspect cache_busy via commitDetailed. */
export class SnapshotStoreAdapter implements SnapshotStore {
  constructor(readonly detailed: NormalizedCacheStore) {}

  async read(_options?: SnapshotStoreReadOptions): Promise<StoredSnapshot | null> {
    const result = await this.detailed.readDetailed();
    return result.status === "available" ? result.snapshot : null;
  }

  async commit(snapshot: StoredSnapshot, options?: SnapshotStoreCommitOptions): Promise<void> {
    if (options?.signal?.aborted) {
      throw new DomainError("cancelled", "The cache commit was cancelled");
    }
    const result = await this.detailed.commitDetailed(snapshot);
    if (result.status === "cache_busy") {
      throw new DomainError("cache-busy", "Another OC2Token process owns the cache lock", {
        retryable: true,
      });
    }
    if (result.status === "cache_unavailable") {
      throw new DomainError("cache-unavailable", "The cache commit could not be published", {
        cause: result.error,
        retryable: true,
      });
    }
  }
}

export function createSnapshotStore(options: CacheStoreOptions): SnapshotStoreAdapter {
  return new SnapshotStoreAdapter(new NormalizedCacheStore(options));
}

export function createNormalizedCacheStore(options: CacheStoreOptions): NormalizedCacheStore {
  return new NormalizedCacheStore(options);
}
