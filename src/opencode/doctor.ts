import {
  DomainError,
  type OpenCodeTransport,
  type UsageWindow,
} from "../domain/index.js";
import {
  connectOpenCode,
  type ConnectionOptions,
  type OpenCodeConnection,
} from "./client.js";
import { isStatsRangeMismatch, OpenCode2Transport, type StatsRequestOptions } from "./transport.js";

export type DoctorCheckName = "service" | "health" | "stats-range" | "opencode" | "codex" | "antigravity";

export interface DoctorCheck {
  readonly name: DoctorCheckName;
  readonly ok: boolean;
  readonly message: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: ReadonlyArray<DoctorCheck>;
  readonly endpoint?: string;
  readonly version?: string;
  readonly fingerprint?: string;
}

export interface DoctorOptions extends ConnectionOptions {
  readonly connection?: OpenCodeConnection;
  readonly transport?: OpenCodeTransport;
  /** If supplied, doctor also verifies the filtered stats range. */
  readonly window?: UsageWindow;
  readonly project?: string;
}

function publicError(error: unknown): string {
  if (error instanceof DomainError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Run non-mutating local diagnostics. By default it only discovers a running
 * service; pass ensure:true when a caller explicitly wants service startup.
 */
export async function runOpenCodeDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let connection = options.connection;
  let transport = options.transport;

  if (connection === undefined && transport === undefined) {
    try {
      connection = await connectOpenCode({ ...options, ensure: options.ensure ?? false });
      checks.push({ name: "service", ok: true, message: "OpenCode 2 service discovered" });
      transport = new OpenCode2Transport({ client: connection.client });
    } catch (error) {
      checks.push({ name: "service", ok: false, message: publicError(error) });
      return { ok: false, checks };
    }
  } else {
    checks.push({ name: "service", ok: true, message: "Injected OpenCode transport is available" });
  }

  if (transport === undefined && connection !== undefined) {
    transport = new OpenCode2Transport({ client: connection.client });
  }

  if (connection !== undefined) {
    checks.push({
      name: "health",
      ok: true,
      message: `healthy V2 service ${connection.health.version}`,
    });
  } else if (transport !== undefined) {
    try {
      const health = await transport.getHealth({ signal: options.signal });
      checks.push({ name: "health", ok: true, message: `healthy V2 service ${health.version}` });
    } catch (error) {
      checks.push({ name: "health", ok: false, message: publicError(error) });
    }
  }

  if (options.window !== undefined && transport !== undefined) {
    try {
      const statsOptions: StatsRequestOptions = {
        project: options.project,
        signal: options.signal,
      };
      await transport.getSessionStats(options.window, statsOptions);
      checks.push({ name: "stats-range", ok: true, message: "filtered stats range is honored" });
    } catch (error) {
      checks.push({
        name: "stats-range",
        ok: false,
        message: isStatsRangeMismatch(error)
          ? "filtered stats range is not honored; use paginated message fallback"
          : publicError(error),
      });
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
    ...(connection === undefined ? {} : {
      endpoint: connection.endpoint.url,
      version: connection.health.version,
      fingerprint: connection.health.fingerprint,
    }),
  };
}

export const doctor = runOpenCodeDoctor;
