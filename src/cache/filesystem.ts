import { promises as nodeFs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname as nodeHostname } from "node:os";
import process from "node:process";

import type { CacheFileHandle, CacheFileStat, CacheFileSystem, CacheProcess, CacheRandom } from "./types.js";

function adaptFileHandle(handle: FileHandle): CacheFileHandle {
  return {
    async writeFile(data: string): Promise<void> {
      await handle.writeFile(data, "utf8");
    },
    async sync(): Promise<void> {
      await handle.sync();
    },
    async close(): Promise<void> {
      await handle.close();
    },
  };
}

/** Node's promises API is kept behind this adapter so tests can inject a fake filesystem. */
export const nodeCacheFileSystem: CacheFileSystem = {
  async mkdir(path, options): Promise<void> {
    await nodeFs.mkdir(path, options);
  },
  async open(path, flags, mode): Promise<CacheFileHandle> {
    return adaptFileHandle(await nodeFs.open(path, flags, mode));
  },
  async readFile(path, encoding): Promise<string> {
    return nodeFs.readFile(path, { encoding });
  },
  async rename(from, to): Promise<void> {
    await nodeFs.rename(from, to);
  },
  async unlink(path): Promise<void> {
    await nodeFs.unlink(path);
  },
  async rm(path, options): Promise<void> {
    await nodeFs.rm(path, options);
  },
  async readdir(path): Promise<readonly string[]> {
    return nodeFs.readdir(path);
  },
  async stat(path): Promise<CacheFileStat> {
    return nodeFs.stat(path);
  },
};

export const systemCacheProcess: CacheProcess = {
  pid: process.pid,
  hostname: nodeHostname(),
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // EPERM means the process exists but we are not allowed to signal it.
      return code === "EPERM";
    }
  },
};

export const systemCacheClock = {
  now(): Date {
    return new Date();
  },
};

export const systemCacheRandom: CacheRandom = {
  uuid(): string {
    return randomUUID();
  },
};
