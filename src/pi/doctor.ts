import { readFileSync } from "node:fs";

import { discoverPiSessionFiles } from "./discovery.js";
import type { PiEntry } from "./types.js";

export interface PiDoctorCheck {
  readonly name: "pi";
  readonly ok: boolean;
  /** No Pi store exists; default `doctor` treats this as optional. */
  readonly missing?: boolean;
  readonly message: string;
}

export async function runPiDoctor(): Promise<PiDoctorCheck> {
  let files: string[];
  try {
    files = discoverPiSessionFiles();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: "pi", ok: false, message: `Pi discovery failed: ${message}` };
  }

  if (files.length === 0) {
    return { name: "pi", ok: false, missing: true, message: "No Pi session files found" };
  }

  const file = files[0]!;
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: "pi", ok: false, message: `Found ${files.length} Pi session file(s) but read failed: ${message}` };
  }

  let parsed = 0;
  let hasUsage = false;
  try {
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (line.length === 0) continue;
      const entry = JSON.parse(line) as PiEntry;
      parsed += 1;
      if (entry.type === "message" && entry.message?.usage !== undefined) hasUsage = true;
      if (entry.type === "usage") hasUsage = true;
    }
  } catch {
    return {
      name: "pi",
      ok: false,
      message: `Found ${files.length} Pi session file(s) but JSON parse failed in ${file}`,
    };
  }

  if (parsed === 0) {
    return { name: "pi", ok: false, message: `Found ${files.length} Pi session file(s) but first file is empty` };
  }
  return {
    name: "pi",
    ok: true,
    message: `Found ${files.length} Pi session file(s); ${hasUsage ? "usage found" : "JSON parse OK (no usage entries yet)"}`,
  };
}
