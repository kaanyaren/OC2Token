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

/**
 * Port of codeburn walkRolloutFiles (dist/main.js:5560).
 * Walks ~/.codex/sessions/YYYY/MM/DD + archived_sessions for rollout-*.jsonl.
 */
export function discoverRolloutFiles(root?: string): string[] {
  const codexDir = resolveCodexHome(root);
  const files: string[] = [];

  const take = (dir: string, file: string): void => {
    if (file.startsWith("rollout-") && file.endsWith(".jsonl")) {
      files.push(join(dir, file));
    }
  };

  const sessionsDir = join(codexDir, "sessions");
  try {
    for (const year of readdirSync(sessionsDir)) {
      if (!/^\d{4}$/.test(year)) {
        continue;
      }
      const yearDir = join(sessionsDir, year);
      let months: string[];
      try {
        months = readdirSync(yearDir);
      } catch {
        continue;
      }
      for (const month of months) {
        if (!/^\d{2}$/.test(month)) {
          continue;
        }
        const monthDir = join(yearDir, month);
        let days: string[];
        try {
          days = readdirSync(monthDir);
        } catch {
          continue;
        }
        for (const day of days) {
          if (!/^\d{2}$/.test(day)) {
            continue;
          }
          const dayDir = join(monthDir, day);
          let entries: string[];
          try {
            entries = readdirSync(dayDir);
          } catch {
            continue;
          }
          for (const file of entries) {
            take(dayDir, file);
          }
        }
      }
    }
  } catch {
    // sessions directory missing — ignore, fall through to archived_sessions
  }

  const archivedDir = join(codexDir, "archived_sessions");
  try {
    for (const file of readdirSync(archivedDir)) {
      take(archivedDir, file);
    }
  } catch {
    // archived_sessions missing — ignore
  }

  return files;
}
