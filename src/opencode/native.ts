import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DiscoverOptions, Endpoint } from "@opencode-ai/client/service";
import { headers as serviceHeaders } from "@opencode-ai/client/service";
import type { OpenCodeClientLike } from "./client.js";

export interface NativeDiscoveryOptions extends DiscoverOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

function defaultServiceFile(): string {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(base, "opencode", "service.json");
}

interface ServiceRegistration {
  readonly url: string;
  readonly password?: string;
  readonly pid?: unknown;
  readonly version?: unknown;
}

async function readRegistration(file?: string): Promise<ServiceRegistration | undefined> {
  const path = file ?? defaultServiceFile();
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.url !== "string" || parsed.url.length === 0) return undefined;
    return {
      url: parsed.url,
      ...(typeof parsed.password === "string" ? { password: parsed.password } : {}),
      ...(parsed.pid === undefined ? {} : { pid: parsed.pid }),
      ...(parsed.version === undefined ? {} : { version: parsed.version }),
    };
  } catch {
    return undefined;
  }
}

function endpointFromRegistration(registration: ServiceRegistration): Endpoint {
  return {
    url: registration.url,
    ...(registration.password === undefined
      ? {}
      : { auth: { type: "basic" as const, username: "opencode", password: registration.password } }),
  };
}

function matchesVersion(version: string | undefined, options: DiscoverOptions): boolean {
  if (options.version === undefined) return true;
  if (version === undefined) return false;
  if (typeof options.version === "function") return options.version(version);
  return version === options.version;
}

function authHeaders(endpoint: Endpoint): Record<string, string> {
  return serviceHeaders(endpoint) ?? {};
}

async function fetchJson(
  endpoint: Endpoint,
  path: string,
  query: Record<string, string | number | undefined>,
  fetchFn: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = new URL(path, endpoint.url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const response = await fetchFn(url.toString(), {
    method: "GET",
    headers: { accept: "application/json", ...authHeaders(endpoint) },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    const error = new Error(`OpenCode service returned HTTP ${response.status} for ${path}`);
    (error as unknown as Record<string, unknown>).status = response.status;
    (error as unknown as Record<string, unknown>).response = response;
    throw error;
  }
  return response.json();
}

async function probeInfo(
  endpoint: Endpoint,
  fetchFn: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  try {
    const body = (await fetchJson(endpoint, "/api/info", {}, fetchFn, signal)) as Record<string, unknown>;
    if (typeof body.version === "string") return body;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Discover a running OpenCode 2 service without depending on the generated
 * client's `/api/health` probe (removed in server 2.0.6; replaced by
 * `/api/info`). Reads the same registration file and probes `/api/info`.
 */
export async function discoverNativeEndpoint(
  options: NativeDiscoveryOptions = {},
): Promise<Endpoint | undefined> {
  const registration = await readRegistration(options.file);
  if (registration === undefined) return undefined;
  const endpoint = endpointFromRegistration(registration);
  const fetchFn = options.fetch ?? globalThis.fetch;
  const info = await probeInfo(endpoint, fetchFn, options.signal);
  if (info === undefined) {
    // Fall back to a legacy /api/health probe for pre-2.0 servers.
    try {
      const legacy = (await fetchJson(
        endpoint,
        "/api/health",
        {},
        fetchFn,
        options.signal,
      )) as Record<string, unknown>;
      if (legacy.healthy !== true || typeof legacy.version !== "string") return undefined;
      if (!matchesVersion(legacy.version, options)) return undefined;
      return endpoint;
    } catch {
      return undefined;
    }
  }
  if (!matchesVersion(info.version as string, options)) return undefined;
  return endpoint;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as Record<string, unknown>).status;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

/**
 * HTTP client speaking the server 2.0.6 routes directly:
 * - health via `/api/info` (fallback `/api/health`)
 * - stats via `/api/experimental/session/stats` (fallback `/api/session/stats`)
 * - sessions via `/api/session`, messages via `/api/session/{id}/message`
 *
 * Implements the same OpenCodeClientLike seam as the generated client so the
 * existing transport, retry, and parsing logic is reused unchanged.
 */
export function createNativeClient(
  endpoint: Endpoint,
  options: { readonly fetch?: typeof globalThis.fetch } = {},
): OpenCodeClientLike {
  const fetchFn = options.fetch ?? globalThis.fetch;

  async function get(path: string, query: Record<string, string | number | undefined>, requestOptions?: { signal?: unknown }): Promise<unknown> {
    const signal = (requestOptions as { signal?: AbortSignal } | undefined)?.signal;
    return fetchJson(endpoint, path, query, fetchFn, signal);
  }

  return {
    health: {
      get: async (requestOptions?: { signal?: AbortSignal }): Promise<unknown> => {
        try {
          return await get("/api/info", {}, requestOptions);
        } catch (error) {
          if (statusOf(error) !== 404) throw error;
          return get("/api/health", {}, requestOptions);
        }
      },
    },
    session: {
      list: async (input?: Record<string, unknown>, requestOptions?: { signal?: AbortSignal }): Promise<unknown> => {
        const query: Record<string, string | number | undefined> = {};
        if (input !== null && typeof input === "object") {
          for (const key of ["limit", "cursor", "order", "search", "parentID", "directory", "project", "subpath", "workspace"]) {
            const value = (input as Record<string, unknown>)[key];
            if (typeof value === "string" || typeof value === "number") query[key] = value;
          }
        }
        return get("/api/session", query, requestOptions);
      },
      stats: async (input?: Record<string, unknown>, requestOptions?: { signal?: AbortSignal }): Promise<unknown> => {
        const query: Record<string, string | number | undefined> = {};
        if (input !== null && typeof input === "object") {
          for (const key of ["from", "to", "project", "timezone", "tools"]) {
            const value = (input as Record<string, unknown>)[key];
            if (typeof value === "string" || typeof value === "number") query[key] = value;
          }
        }
        try {
          const body = await get("/api/experimental/session/stats", query, requestOptions);
          if (
            typeof body === "object" &&
            body !== null &&
            "data" in (body as Record<string, unknown>) &&
            !("range" in (body as Record<string, unknown>))
          ) {
            return (body as Record<string, unknown>).data;
          }
          return body;
        } catch (error) {
          if (statusOf(error) !== 404) throw error;
          const fallback = await get("/api/session/stats", query, requestOptions);
          if (
            typeof fallback === "object" &&
            fallback !== null &&
            "data" in (fallback as Record<string, unknown>) &&
            !("range" in (fallback as Record<string, unknown>))
          ) {
            return (fallback as Record<string, unknown>).data;
          }
          return fallback;
        }
      },
    },
    message: {
      list: async (input?: Record<string, unknown>, requestOptions?: { signal?: AbortSignal }): Promise<unknown> => {
        const record = (input ?? {}) as Record<string, unknown>;
        const sessionID = record.sessionID;
        if (typeof sessionID !== "string" || sessionID.length === 0) {
          throw new Error("message list requires a sessionID");
        }
        const query: Record<string, string | number | undefined> = {};
        for (const key of ["limit", "cursor", "order", "type"]) {
          const value = record[key];
          if (typeof value === "string" || typeof value === "number") query[key] = value;
        }
        return get(`/api/session/${encodeURIComponent(sessionID)}/message`, query, requestOptions);
      },
    },
    project: {
      list: async (requestOptions?: { signal?: AbortSignal }): Promise<unknown> => {
        return get("/api/project", {}, requestOptions);
      },
    },
  };
}
