import { readFileSync } from "node:fs";

import { discoverDeepSeekSessionFiles } from "./discovery.js";
import { isZstdDecompressionAvailable, readZstdFile } from "./zstd.js";
import type { DeepSeekEntry } from "./types.js";

export interface DeepSeekDoctorCheck {
  readonly name: "deepseek";
  readonly ok: boolean;
  /** No DeepSeek Harness store exists; default `doctor` treats this as optional. */
  readonly missing?: boolean;
  readonly message: string;
}

function usageInEntry(entry: DeepSeekEntry): boolean {
  const data = entry.data;
  if (data === undefined || typeof data !== "object") return false;
  if (data.usage !== undefined) return true;
  if (entry.type !== "assistant/attempt") return false;
  const stream = data.stream;
  if (!Array.isArray(stream)) return false;
  return stream.some((record) => {
    if (typeof record !== "object" || record === null) return false;
    const chunk = (record as Record<string, unknown>).chunk;
    return typeof chunk === "object" && chunk !== null && (chunk as Record<string, unknown>).type === "usage";
  });
}

export async function runDeepSeekDoctor(): Promise<DeepSeekDoctorCheck> {
  let files;
  try {
    files = discoverDeepSeekSessionFiles();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: "deepseek", ok: false, message: `DeepSeek discovery failed: ${message}` };
  }

  if (files.length === 0) {
    return {
      name: "deepseek",
      ok: false,
      missing: true,
      message: "No DeepSeek Harness session files found",
    };
  }

  const file = files[0]!;
  if (file.compressed && !isZstdDecompressionAvailable()) {
    return {
      name: "deepseek",
      ok: false,
      message: `Found ${files.length} DeepSeek session file(s), but zstd decompression is unavailable (need Node >=22.15 or the zstd CLI)`,
    };
  }

  let content: string;
  try {
    const buffer = readFileSync(file.path);
    content = file.compressed ? readZstdFile(file.path, buffer).toString("utf8") : buffer.toString("utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "deepseek",
      ok: false,
      message: `Found ${files.length} DeepSeek session file(s) but read failed: ${message}`,
    };
  }

  let parsed = 0;
  let hasUsage = false;
  let hasHeader = false;
  try {
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (line.length === 0) continue;
      const entry = JSON.parse(line) as DeepSeekEntry;
      parsed += 1;
      if (entry.type === "session") hasHeader = true;
      if (usageInEntry(entry)) hasUsage = true;
    }
  } catch {
    return {
      name: "deepseek",
      ok: false,
      message: `Found ${files.length} DeepSeek session file(s) but JSON parse failed in ${file.path}`,
    };
  }

  if (parsed === 0) {
    return {
      name: "deepseek",
      ok: false,
      message: `Found ${files.length} DeepSeek session file(s) but first file is empty`,
    };
  }
  if (!hasHeader) {
    return {
      name: "deepseek",
      ok: false,
      message: `Found ${files.length} DeepSeek session file(s) but the first file has no session header`,
    };
  }
  return {
    name: "deepseek",
    ok: true,
    message: `Found ${files.length} DeepSeek session file(s); ${hasUsage ? "usage found" : "JSON parse OK (no usage entries yet)"}`,
  };
}
