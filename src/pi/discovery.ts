import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Bounds so a huge agent directory can never hang discovery. */
const MAX_SESSION_FILES = 50_000;
const MAX_ENTRIES_PER_DIR = 10_000;

/**
 * Pi's session root. `PI_CODING_AGENT_SESSION_DIR` overrides storage outright;
 * otherwise sessions live under `<agent-dir>/sessions`, where the agent
 * directory is `PI_CODING_AGENT_DIR` or `~/.pi/agent`.
 */
export function defaultPiSessionDirectory(): string {
  const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (typeof sessionDir === "string" && sessionDir.trim().length > 0) {
    return sessionDir;
  }
  const agentDirEnv = process.env.PI_CODING_AGENT_DIR;
  const agentDir =
    typeof agentDirEnv === "string" && agentDirEnv.trim().length > 0 ? agentDirEnv : join(homedir(), ".pi", "agent");

  // The `sessionDir` setting is read before project trust and may relocate
  // storage without an environment variable being set.
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
      sessionDir?: unknown;
    };
    if (typeof settings.sessionDir === "string" && settings.sessionDir.trim().length > 0) {
      const configured = settings.sessionDir.trim();
      const expanded =
        configured === "~"
          ? homedir()
          : configured.startsWith("~/")
            ? join(homedir(), configured.slice(2))
            : configured;
      return isAbsolute(expanded) ? expanded : join(agentDir, expanded);
    }
  } catch {
    // Missing/corrupt settings are not a discovery failure.
  }

  return join(agentDir, "sessions");
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
    // Never follow symlinks (files or dirs) during discovery.
    if (entry.isSymbolicLink()) continue;
    names.push(entry.name);
  }
  return names;
}

function isSessionFile(name: string): boolean {
  return name.endsWith(".jsonl") && !name.endsWith(".lock.jsonl");
}

/**
 * Walk Pi's session store. Layout is
 * `<root>/--<normalized-cwd>--/<timestamp>_<session-id>.jsonl`; a shallow
 * second pass also accepts session files stored directly in the root.
 */
export function discoverPiSessionFiles(root?: string): string[] {
  const sessionRoot = root ?? defaultPiSessionDirectory();
  const files: string[] = [];

  for (const entry of readDirEntries(sessionRoot)) {
    if (files.length >= MAX_SESSION_FILES) break;
    const path = join(sessionRoot, entry);
    if (isSessionFile(entry)) {
      files.push(path);
      continue;
    }
    for (const nested of readDirEntries(path)) {
      if (files.length >= MAX_SESSION_FILES) break;
      if (!isSessionFile(nested)) continue;
      files.push(join(path, nested));
    }
  }

  return files.sort();
}
