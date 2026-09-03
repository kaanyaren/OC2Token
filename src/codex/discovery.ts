import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";

export function defaultCodexHome(): string {
  return join(homedir(), ".codex");
}

function resolveCodexHome(root?: string): string {
  if (root !== undefined) {
    return root;
  }
  const env = process.env.CODEX_HOME;
  if (typeof env === "string" && env.trim().length > 0) {
    return env;
  }
  return defaultCodexHome();
}

/** Bounds so a huge $HOME can never hang discovery. */
const MAX_ROLLOUT_FILES = 20_000;
const MAX_ENTRIES_PER_DIR = 10_000;

function readDirEntries(dir: string): string[] {
  let entries;
  try {
    // withFileTypes lets us skip symlinks without extra stat calls; symlinks
    // are never followed so a linked giant tree cannot hang or loop us.
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (names.length >= MAX_ENTRIES_PER_DIR) break;
    // Never follow symlinks (files or dirs) during discovery.
    if (entry.isSymbolicLink()) continue;
    names.push(entry.name);
  }
  return names;
}

function isRolloutFile(name: string): boolean {
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

/**
 * Port of codeburn walkRolloutFiles (dist/main.js:5560).
 * Walks ~/.codex/sessions/YYYY/MM/DD + archived_sessions for rollout-*.jsonl.
 *
 * Traversal depth is fixed (year/month/day, no recursion), symlinks are
 * skipped, and results are capped at MAX_ROLLOUT_FILES so huge homes fail
 * bounded instead of hanging.
 */
export function discoverRolloutFiles(root?: string): string[] {
  const codexDir = resolveCodexHome(root);
  const files: string[] = [];

  const take = (dir: string, file: string): void => {
    if (files.length >= MAX_ROLLOUT_FILES) return;
    if (isRolloutFile(file)) {
      files.push(join(dir, file));
    }
  };

  const sessionsDir = join(codexDir, "sessions");
  for (const year of readDirEntries(sessionsDir)) {
    if (files.length >= MAX_ROLLOUT_FILES) break;
    if (!/^\d{4}$/.test(year)) {
      continue;
    }
    const yearDir = join(sessionsDir, year);
    for (const month of readDirEntries(yearDir)) {
      if (files.length >= MAX_ROLLOUT_FILES) break;
      if (!/^\d{2}$/.test(month)) {
        continue;
      }
      const monthDir = join(yearDir, month);
      for (const day of readDirEntries(monthDir)) {
        if (files.length >= MAX_ROLLOUT_FILES) break;
        if (!/^\d{2}$/.test(day)) {
          continue;
        }
        const dayDir = join(monthDir, day);
        for (const file of readDirEntries(dayDir)) {
          take(dayDir, file);
          if (files.length >= MAX_ROLLOUT_FILES) break;
        }
      }
    }
  }

  const archivedDir = join(codexDir, "archived_sessions");
  for (const file of readDirEntries(archivedDir)) {
    take(archivedDir, file);
    if (files.length >= MAX_ROLLOUT_FILES) break;
  }

  return files;
}
