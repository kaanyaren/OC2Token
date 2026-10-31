import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_SESSION_FILES = 50_000;
const MAX_ENTRIES_PER_DIR = 10_000;

/** `${DSH_HOME:-~/.dsh}/sessions`. */
export function defaultDeepSeekSessionsDirectory(): string {
  const home = process.env.DSH_HOME;
  const base = typeof home === "string" && home.trim().length > 0 ? home : join(homedir(), ".dsh");
  return join(base, "sessions");
}

function readDirEntries(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (names.length >= MAX_ENTRIES_PER_DIR) break;
    if (entry.isSymbolicLink()) continue;
    names.push(entry.name);
  }
  return names;
}

export interface DeepSeekSessionFile {
  readonly path: string;
  readonly version: number;
  readonly compressed: boolean;
}

/**
 * Parse a canonical generation filename: `session.jsonl`, `session.v4.jsonl`,
 * optionally with a `.zstd` suffix. Noncanonical/temporary names are ignored.
 */
export function parseDeepSeekSessionFilename(name: string): { version: number; compressed: boolean } | undefined {
  const match = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(name);
  if (match === null) return undefined;
  const rawVersion = match[1];
  const version = rawVersion === undefined ? 0 : Number(rawVersion);
  if (!Number.isSafeInteger(version) || version < 0) return undefined;
  return { version, compressed: match[2] !== undefined };
}

/**
 * Walk `${DSH_HOME:-~/.dsh}/sessions/<workspace-slug>/<session-id>/` and select
 * the newest canonical generation per session directory. Older generations are
 * retained by dsh beside the current one and must not be double-counted.
 */
export function discoverDeepSeekSessionFiles(root?: string): DeepSeekSessionFile[] {
  const sessionsRoot = root ?? defaultDeepSeekSessionsDirectory();
  const selected: DeepSeekSessionFile[] = [];

  for (const projectEntry of readDirEntries(sessionsRoot)) {
    if (selected.length >= MAX_SESSION_FILES) break;
    const projectDir = join(sessionsRoot, projectEntry);
    for (const sessionEntry of readDirEntries(projectDir)) {
      if (selected.length >= MAX_SESSION_FILES) break;
      const sessionDir = join(projectDir, sessionEntry);
      let best: DeepSeekSessionFile | undefined;
      for (const fileEntry of readDirEntries(sessionDir)) {
        const parsed = parseDeepSeekSessionFilename(fileEntry);
        if (parsed === undefined) continue;
        const candidate: DeepSeekSessionFile = {
          path: join(sessionDir, fileEntry),
          version: parsed.version,
          compressed: parsed.compressed,
        };
        if (
          best === undefined ||
          candidate.version > best.version ||
          // Same version in both encodings: raw is cheaper to read.
          (candidate.version === best.version && best.compressed && !candidate.compressed)
        ) {
          best = candidate;
        }
      }
      if (best !== undefined) selected.push(best);
    }
  }

  return selected.sort((left, right) => left.path.localeCompare(right.path));
}
