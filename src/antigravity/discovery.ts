import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";

export function defaultAntigravityHome(): string {
  return join(homedir(), ".gemini");
}

function resolveAntigravityHome(root?: string): string {
  if (root !== undefined) {
    return root;
  }
  const env = process.env.ANTIGRAVITY_HOME;
  if (typeof env === "string" && env.trim().length > 0) {
    return env;
  }
  return defaultAntigravityHome();
}

/**
 * Scan Antigravity SQLite conversation databases.
 *
 * Mirrors codeburn `conversationRoots()` (dist/main.js:1674) scanning:
 * - ~/.gemini/antigravity/conversations
 * - ~/.gemini/antigravity-cli/conversations
 * - ~/.gemini/antigravity-cli/implicit
 * - ~/.gemini/antigravity-ide/conversations
 * - ~/.gemini/antigravity-ide/implicit
 *
 * Only `*.db` files are returned; `-shm`/`-wal` sidecars are ignored
 * (they do not end with `.db`). Supports `ANTIGRAVITY_HOME` override via
 * `resolveAntigravityHome` or explicit `root` parameter.
 * For test fixtures `ANTIGRAVITY_HOME` may point directly to a directory
 * containing `*.db` files — that directory is scanned as well.
 */
export function discoverAntigravityDatabases(root?: string): string[] {
  const base = resolveAntigravityHome(root);
  const seen = new Set<string>();
  const result: string[] = [];

  const tryDir = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const file of entries) {
      // Only *.db — ignore -shm/-wal sidecars and .pb files
      if (!file.toLowerCase().endsWith(".db")) {
        continue;
      }
      // Extra guard for sidecars that might be named *.db-shm / *.db-wal
      const lower = file.toLowerCase();
      if (lower.endsWith("-shm") || lower.endsWith("-wal") || lower.endsWith(".db-shm") || lower.endsWith(".db-wal")) {
        continue;
      }
      const full = join(dir, file);
      if (seen.has(full)) {
        continue;
      }
      seen.add(full);
      result.push(full);
    }
  };

  // Direct base scan — handles ANTIGRAVITY_HOME pointing to a conversations dir
  // or a test fixture containing .db files flat.
  tryDir(base);

  // Known relative paths (codeburn conversationRoots) relative to homedir base.
  // We probe both interpretations of `base`:
  // - base is homedir (e.g. /Users/you) -> join(base, ".gemini", ...)
  // - base is .gemini dir (e.g. /Users/you/.gemini) -> join(base, "antigravity", ...)
  const relativeFromHomedir = [
    join(".gemini", "antigravity", "conversations"),
    join(".gemini", "antigravity-cli", "conversations"),
    join(".gemini", "antigravity-cli", "implicit"),
    join(".gemini", "antigravity-ide", "conversations"),
    join(".gemini", "antigravity-ide", "implicit"),
  ];
  const relativeFromGemini = [
    join("antigravity", "conversations"),
    join("antigravity-cli", "conversations"),
    join("antigravity-cli", "implicit"),
    join("antigravity-ide", "conversations"),
    join("antigravity-ide", "implicit"),
  ];

  for (const rel of relativeFromHomedir) {
    tryDir(join(base, rel));
  }
  for (const rel of relativeFromGemini) {
    tryDir(join(base, rel));
  }

  // Also handle case where base is already a .gemini/antigravity-cli/conversations path's parent
  // by not duplicating — seen set handles it.

  result.sort();
  return result;
}
