import { readFileSync } from "node:fs";

import { discoverRolloutFiles } from "./discovery.js";

export interface CodexDoctorCheck {
  readonly name: "codex";
  readonly ok: boolean;
  readonly message: string;
}

export async function runCodexDoctor(): Promise<CodexDoctorCheck> {
  let files: string[];
  try {
    files = discoverRolloutFiles();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: "codex", ok: false, message: `Codex discovery failed: ${message}` };
  }

  if (files.length === 0) {
    return { name: "codex", ok: false, message: "No Codex rollout files found" };
  }

  const file = files[0]!;
  try {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    let jsonParseOk = false;
    let hasLines = false;
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      hasLines = true;
      try {
        const entry = JSON.parse(trimmed) as Record<string, unknown>;
        // At least one line parsed as JSON is enough for probe.
        jsonParseOk = true;
        if (entry.type === "event_msg" && (entry.payload as Record<string, unknown> | null)?.type === "token_count") {
          jsonParseOk = true;
          break;
        }
      } catch {
        return { name: "codex", ok: false, message: `Found ${files.length} Codex rollout file(s) but JSON parse failed in ${file}` };
      }
    }
    if (!hasLines) {
      return { name: "codex", ok: false, message: `Found ${files.length} Codex rollout file(s) but first file is empty` };
    }
    if (jsonParseOk) {
      return { name: "codex", ok: true, message: `Found ${files.length} Codex rollout file(s); parse OK` };
    }
    return { name: "codex", ok: true, message: `Found ${files.length} Codex rollout file(s); JSON parse OK` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: "codex", ok: false, message: `Found ${files.length} Codex rollout file(s) but read failed: ${message}` };
  }
}
