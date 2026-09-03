import { join } from "node:path";

import { DomainError } from "../domain/errors.js";
import { nodeCacheFileSystem, systemCacheClock, systemCacheProcess, systemCacheRandom } from "./filesystem.js";
import {
  LOCK_DIRECTORY_NAME,
  type CacheClock,
  type CacheFileSystem,
  type CacheOwner,
  type CacheProcess,
  type CacheRandom,
} from "./types.js";

export interface CacheLockDependencies {
  readonly fs?: CacheFileSystem;
  readonly clock?: CacheClock;
  readonly process?: CacheProcess;
  readonly random?: CacheRandom;
  readonly staleLockMs?: number;
}

export interface CacheLockBusy {
  readonly status: "busy";
  readonly owner?: CacheOwner;
}

export interface CacheLockAcquired {
  readonly status: "acquired";
  readonly owner: CacheOwner;
  release(): Promise<void>;
}

export type CacheLockResult = CacheLockAcquired | CacheLockBusy;

const LOCK_OWNER_FILE = "owner.json";
const DEFAULT_STALE_LOCK_MS = 30 * 60 * 1000;

function codeOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function isAlreadyExists(error: unknown): boolean {
  return codeOf(error) === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return codeOf(error) === "ENOENT";
}

function validOwner(value: unknown): value is CacheOwner {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(record.pid) &&
    (record.pid as number) > 0 &&
    typeof record.host === "string" &&
    record.host.length > 0 &&
    typeof record.start === "string" &&
    !Number.isNaN(Date.parse(record.start)) &&
    typeof record.owner === "string" &&
    /^[^\u0000-\u001f]{1,256}$/.test(record.owner)
  );
}

function sameOwner(left: CacheOwner | undefined, right: CacheOwner | undefined): boolean {
  return Boolean(
    left &&
      right &&
      left.pid === right.pid &&
      left.host === right.host &&
      left.start === right.start &&
      left.owner === right.owner,
  );
}

function clockNow(clock: CacheClock): Date {
  const value = clock.now?.() ?? clock.wallNow?.();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new DomainError("invalid-date", "cache clock must return a valid Date");
  }
  return value;
}

async function closeQuietly(handle: { close(): Promise<void> }): Promise<void> {
  try {
    await handle.close();
  } catch {
    // The original operation is more useful than a secondary close failure.
  }
}

async function writeOwner(
  fs: CacheFileSystem,
  path: string,
  owner: CacheOwner,
): Promise<void> {
  const handle = await fs.open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`);
    await handle.sync();
  } finally {
    await closeQuietly(handle);
  }
}

export class CacheLock {
  readonly lockPath: string;

  private readonly fs: CacheFileSystem;
  private readonly clock: CacheClock;
  private readonly process: CacheProcess;
  private readonly random: CacheRandom;
  private readonly staleLockMs: number;

  constructor(readonly directory: string, dependencies: CacheLockDependencies = {}) {
    this.lockPath = join(directory, LOCK_DIRECTORY_NAME);
    this.fs = dependencies.fs ?? nodeCacheFileSystem;
    this.clock = dependencies.clock ?? systemCacheClock;
    this.process = dependencies.process ?? systemCacheProcess;
    this.random = dependencies.random ?? systemCacheRandom;
    this.staleLockMs = dependencies.staleLockMs ?? DEFAULT_STALE_LOCK_MS;

    if (!Number.isFinite(this.staleLockMs) || this.staleLockMs < 0) {
      throw new DomainError("invalid-window", "staleLockMs must be a finite non-negative number");
    }
  }

  async readOwner(): Promise<CacheOwner | undefined> {
    try {
      const contents = await this.fs.readFile(join(this.lockPath, LOCK_OWNER_FILE), "utf8");
      const parsed: unknown = JSON.parse(contents);
      return validOwner(parsed) ? parsed : undefined;
    } catch (error) {
      // Only a missing owner file (or corrupt JSON) means "no owner".
      // Permission errors (EACCES/EPERM) and other I/O failures must surface
      // so callers do not mistake "cannot read" for "unlocked".
      if (isMissing(error) || error instanceof SyntaxError) {
        return undefined;
      }
      throw error;
    }
  }

  private async isStale(owner: CacheOwner | undefined, mtimeMs: number): Promise<boolean> {
    const now = clockNow(this.clock).getTime();
    const started = owner ? Date.parse(owner.start) : Number.NaN;
    const age = Number.isFinite(started) ? Math.max(0, now - started) : Math.max(0, now - mtimeMs);

    let alive = true;
    if (owner && owner.host === this.process.hostname && this.process.isAlive) {
      alive = await this.process.isAlive(owner.pid);
    }

    // A dead owner is immediately reclaimable. A live owner can still be
    // reclaimed after the bounded lease, which covers SIGKILL and host restarts.
    return !alive || age >= this.staleLockMs;
  }

  /**
   * Reclaim a stale lock only after checking the same owner a second time.
   * The second read is what prevents a PID-reuse or lock-replacement race from
   * deleting a newly acquired lock.
   */
  private async removeIfStale(): Promise<boolean> {
    let initialOwner = await this.readOwner();
    let stat;
    try {
      stat = await this.fs.stat(this.lockPath);
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      throw error;
    }

    if (!(await this.isStale(initialOwner, stat.mtimeMs))) {
      return false;
    }

    const currentOwner = await this.readOwner();
    if (initialOwner || currentOwner) {
      if (!sameOwner(initialOwner, currentOwner)) {
        return false;
      }
    } else {
      // A lock with no owner file may be between mkdir and owner publication.
      // Re-check its mtime so a freshly-created lock is never removed.
      let currentStat;
      try {
        currentStat = await this.fs.stat(this.lockPath);
      } catch (error) {
        if (isMissing(error)) {
          return false;
        }
        throw error;
      }
      if (currentStat.mtimeMs !== stat.mtimeMs) {
        return false;
      }
    }

    try {
      await this.fs.rm(this.lockPath, { recursive: true, force: false });
      return true;
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      throw error;
    }
  }

  async tryAcquire(): Promise<CacheLockResult> {
    try {
      await this.fs.mkdir(this.lockPath, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw new DomainError("cache-unavailable", "Unable to create the cache lock", { cause: error });
      }

      await this.removeIfStale();
      try {
        await this.fs.mkdir(this.lockPath, { recursive: false, mode: 0o700 });
      } catch (retryError) {
        if (isAlreadyExists(retryError)) {
          return { status: "busy", owner: await this.readOwner() };
        }
        throw new DomainError("cache-unavailable", "Unable to acquire the cache lock", { cause: retryError });
      }
    }

    const owner: CacheOwner = {
      pid: this.process.pid,
      host: this.process.hostname,
      start: clockNow(this.clock).toISOString(),
      owner: this.random.uuid(),
    };

    try {
      await writeOwner(this.fs, join(this.lockPath, LOCK_OWNER_FILE), owner);
    } catch (error) {
      try {
        await this.fs.rm(this.lockPath, { recursive: true, force: true });
      } catch {
        // Preserve the original failure. The next contender will recover it.
      }
      throw new DomainError("cache-unavailable", "Unable to publish the cache lock owner", { cause: error });
    }

    return {
      status: "acquired",
      owner,
      release: async (): Promise<void> => {
        const currentOwner = await this.readOwner();
        if (!sameOwner(owner, currentOwner)) {
          return;
        }
        try {
          await this.fs.rm(this.lockPath, { recursive: true, force: false });
        } catch (error) {
          if (!isMissing(error)) {
            throw new DomainError("cache-unavailable", "Unable to release the cache lock", { cause: error });
          }
        }
      },
    };
  }
}

export function createCacheLock(directory: string, dependencies: CacheLockDependencies = {}): CacheLock {
  return new CacheLock(directory, dependencies);
}

export { DEFAULT_STALE_LOCK_MS };
