import { discoverAntigravityDatabases } from "./discovery.js";
import { isSqliteAvailable } from "./scanner.js";
import { parseProtoFields } from "./proto.js";

export interface AntigravityDoctorCheck {
  readonly name: "antigravity";
  readonly ok: boolean;
  readonly message: string;
}

export async function runAntigravityDoctor(): Promise<AntigravityDoctorCheck> {
  let databases: string[];
  try {
    databases = discoverAntigravityDatabases();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: "antigravity", ok: false, message: `Antigravity discovery failed: ${message}` };
  }

  if (databases.length === 0) {
    return { name: "antigravity", ok: false, message: "No Antigravity databases found" };
  }

  if (!isSqliteAvailable()) {
    return { name: "antigravity", ok: false, message: "node:sqlite unavailable; cannot probe Antigravity databases" };
  }

  const file = databases[0]!;
  try {
    const mod = await import("node:sqlite");
    const DatabaseSync = (mod as unknown as { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => { prepare: (sql: string) => { all: () => Array<{ idx: number; data: unknown }> }; close: () => void; exec?: (sql: string) => void } }).DatabaseSync;
    let db: { prepare: (sql: string) => { all: () => Array<unknown> }; close: () => void; exec?: (sql: string) => void } | null = null;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      try {
        db.exec?.("PRAGMA busy_timeout = 1000");
      } catch {
        // ignore pragma
      }
      const stmt = db.prepare("SELECT idx, data FROM gen_metadata LIMIT 1");
      const rows = stmt.all() as Array<{ idx: number; data: unknown }>;
      if (rows.length === 0) {
        return { name: "antigravity", ok: true, message: `Found ${databases.length} Antigravity database(s); probe query OK (no gen_metadata rows)` };
      }
      const data = rows[0]!.data;
      let bytes: Uint8Array | null = null;
      if (data instanceof Uint8Array) bytes = data;
      else if (typeof data === "string") bytes = new TextEncoder().encode(data);
      else if (data !== null && typeof data === "object" && "buffer" in (data as Record<string, unknown>)) {
        try {
          const buf = data as Buffer;
          bytes = new Uint8Array(buf.buffer ?? buf, (buf as unknown as { byteOffset?: number }).byteOffset ?? 0, buf.length ?? 0);
        } catch {
          bytes = null;
        }
      }
      if (bytes === null) {
        return { name: "antigravity", ok: false, message: `Found ${databases.length} Antigravity database(s) but gen_metadata BLOB could not be read` };
      }
      try {
        parseProtoFields(bytes);
        return { name: "antigravity", ok: true, message: `Found ${databases.length} Antigravity database(s); parse OK` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { name: "antigravity", ok: false, message: `Found ${databases.length} Antigravity database(s) but proto parse failed: ${message}` };
      }
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: "antigravity", ok: false, message: `Found ${databases.length} Antigravity database(s) but SQLite probe failed: ${message}` };
  }
}
