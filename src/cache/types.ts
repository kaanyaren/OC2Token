/* The cache depends only on the shared domain types, never on domain runtime code. */
import type { StoredSnapshot, UsageRecord } from "../domain/index.js";

export type { StoredSnapshot, UsageRecord };

export const CACHE_FORMAT = "oc2token.normalized-cache" as const;
export const RECORDS_FORMAT = "oc2token.normalized-records" as const;
export const MANIFEST_FILE_NAME = "manifest.json" as const;
export const LOCK_DIRECTORY_NAME = ".lock" as const;
export const CURRENT_CACHE_SCHEMA_VERSION = 1 as const;

export interface CacheFileHandle {
  writeFile(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface CacheFileStat {
  readonly mtimeMs: number;
  readonly isFile?: () => boolean;
  readonly isDirectory?: () => boolean;
}

/** The smallest filesystem surface needed by the crash-safe store. */
export interface CacheFileSystem {
  mkdir(path: string, options?: { readonly recursive?: boolean; readonly mode?: number }): Promise<void>;
  open(path: string, flags: string, mode?: number): Promise<CacheFileHandle>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rm(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): Promise<void>;
  readdir(path: string): Promise<readonly string[]>;
  stat(path: string): Promise<CacheFileStat>;
}

export interface CacheClock {
  /** `now` is the cache-local spelling; `wallNow` accepts the shared domain Clock seam. */
  now?(): Date;
  wallNow?(): Date;
}

export interface CacheProcess {
  readonly pid: number;
  readonly hostname: string;
  isAlive?(pid: number): Promise<boolean> | boolean;
}

export interface CacheRandom {
  uuid(): string;
}

export interface CacheDependencies {
  readonly fs?: CacheFileSystem;
  readonly clock?: CacheClock;
  readonly process?: CacheProcess;
  readonly random?: CacheRandom;
}

export type CacheReadUnavailableReason =
  | "cache_busy"
  | "cache_corrupt"
  | "future_schema"
  | "cache_unavailable";

export interface CacheOwner {
  readonly pid: number;
  readonly host: string;
  readonly start: string;
  readonly owner: string;
}

export interface CacheManifest {
  readonly format: typeof CACHE_FORMAT;
  readonly schemaVersion: number;
  readonly manifestVersion: number;
  readonly complete: true;
  readonly generation: number;
  readonly createdAt: string;
  readonly recordFile: string;
  readonly recordBytes: number;
  readonly recordSha256: string;
  readonly snapshot: unknown;
}

export interface CacheReadAvailable {
  readonly status: "available";
  readonly snapshot: StoredSnapshot;
  readonly records: readonly UsageRecord[];
  readonly manifest: CacheManifest;
  readonly migrated: boolean;
}

export interface CacheReadEmpty {
  readonly status: "empty";
}

export interface CacheReadUnavailable {
  readonly status: "unavailable";
  readonly reason: CacheReadUnavailableReason;
  readonly stale: true;
  readonly error?: unknown;
  readonly owner?: CacheOwner;
}

export type CacheReadResult = CacheReadAvailable | CacheReadEmpty | CacheReadUnavailable;

export interface CacheCommitSuccess {
  readonly status: "committed";
  readonly snapshot: StoredSnapshot;
  readonly records: readonly UsageRecord[];
  readonly manifest: CacheManifest;
  readonly recordFile: string;
}

export interface CacheCommitBusy {
  /** The caller must keep using this in-memory snapshot and retry later. */
  readonly status: "cache_busy";
  readonly snapshot: StoredSnapshot;
  readonly records: readonly UsageRecord[];
  readonly owner?: CacheOwner;
}

export interface CacheCommitUnavailable {
  readonly status: "cache_unavailable";
  readonly snapshot: StoredSnapshot;
  readonly records: readonly UsageRecord[];
  readonly error: unknown;
}

export type CacheCommitResult = CacheCommitSuccess | CacheCommitBusy | CacheCommitUnavailable;

export interface OrphanRecoveryResult {
  readonly removed: readonly string[];
  readonly skipped: readonly string[];
  readonly errors: readonly { readonly file: string; readonly error: unknown }[];
}

export interface CacheStoreOptions extends CacheDependencies {
  /** Absolute or relative directory owned by OC2Token. */
  readonly directory?: string;
  /** Alias accepted for callers that call the path a root directory. */
  readonly rootDir?: string;
  readonly staleLockMs?: number;
  /** Set false only for a controlled recovery tool; normal readers leave it true. */
  readonly recoverOrphans?: boolean;
}
