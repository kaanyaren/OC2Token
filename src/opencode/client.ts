import { createHash } from "node:crypto";
import {
  Service,
  headers as serviceHeaders,
  type DiscoverOptions,
  type Endpoint,
  type EnsureOptions,
} from "@opencode-ai/client/service";
import { OpenCode } from "@opencode-ai/client";
import type { OpenCodeHealth } from "../domain/index.js";
import { DomainError, cancellationError } from "../domain/index.js";

/**
 * The generated client has a very large surface and its beta types change
 * independently of OC2Token.  Keeping this small structural seam makes the
 * adapter easy to fake while the default factory still uses the generated
 * client types at runtime.
 */
export interface OpenCodeClientLike {
  readonly health: {
    get(...args: any[]): Promise<unknown>;
  };
  readonly session: {
    list(...args: any[]): Promise<unknown>;
    stats(...args: any[]): Promise<unknown>;
  };
  readonly message: {
    list(...args: any[]): Promise<unknown>;
  };
  readonly project?: {
    list(...args: any[]): Promise<unknown>;
  };
}

export interface ServiceLifecycle {
  discover(options?: DiscoverOptions): Promise<Endpoint | undefined>;
  ensure(options?: EnsureOptions): Promise<Endpoint>;
  headers(endpoint: Endpoint): Record<string, string> | undefined;
}

export const defaultService: ServiceLifecycle = {
  discover: Service.discover,
  ensure: Service.ensure,
  headers: serviceHeaders,
};

export interface OpenCodeClientFactoryOptions {
  readonly fetch?: typeof globalThis.fetch;
}

export type OpenCodeClientFactory = (
  endpoint: Endpoint,
  options?: OpenCodeClientFactoryOptions,
) => OpenCodeClientLike;

/** Create the official promise client with the service's auth headers. */
export function createOpenCodeClient(
  endpoint: Endpoint,
  service: Pick<ServiceLifecycle, "headers"> = defaultService,
  options: OpenCodeClientFactoryOptions = {},
): OpenCodeClientLike {
  return OpenCode.make({
    baseUrl: endpoint.url,
    headers: service.headers(endpoint),
    fetch: options.fetch,
  });
}

export const defaultClientFactory: OpenCodeClientFactory = (endpoint, options) =>
  createOpenCodeClient(endpoint, defaultService, options);

export interface ConnectionOptions {
  readonly service?: ServiceLifecycle;
  readonly client?: OpenCodeClientLike;
  readonly clientFactory?: OpenCodeClientFactory;
  readonly fetch?: typeof globalThis.fetch;
  /** Do not start a service when false. Defaults to true. */
  readonly ensure?: boolean;
  readonly discovery?: Omit<DiscoverOptions, "version">;
  readonly ensureOptions?: Omit<EnsureOptions, "version">;
  readonly version?: string | ((version: string) => boolean);
  readonly signal?: AbortSignal;
}

export interface OpenCodeConnection {
  readonly endpoint: Endpoint;
  readonly client: OpenCodeClientLike;
  readonly health: OpenCodeHealth;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw cancellationError();
  }
}

function assertEndpoint(endpoint: Endpoint): Endpoint {
  if (typeof endpoint.url !== "string" || endpoint.url.trim().length === 0) {
    throw new DomainError("invalid-data", "OpenCode service returned an empty URL");
  }

  let url: URL;
  try {
    url = new URL(endpoint.url);
  } catch (error) {
    throw new DomainError("invalid-data", "OpenCode service returned an invalid URL", {
      cause: error,
    });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DomainError(
      "invalid-data",
      `OpenCode service URL must use http or https, got ${url.protocol}`,
    );
  }

  return { ...endpoint, url: url.toString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readHealth(value: unknown, endpoint: Endpoint): OpenCodeHealth {
  if (!isRecord(value) || value.healthy !== true || typeof value.version !== "string") {
    throw new DomainError(
      "invalid-data",
      "OpenCode health response is missing healthy=true and a version",
    );
  }

  const pid = value.pid;
  if (pid !== undefined && pid !== null && (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 0)) {
    throw new DomainError("invalid-data", "OpenCode health response has an invalid pid");
  }

  // Never hash or report the basic-auth password.  The URL is the advertised
  // endpoint, not the credential-bearing request header.
  const fingerprintInput = `${endpoint.url}\u0000${value.version}\u0000${pid ?? ""}`;
  const fingerprint = createHash("sha256").update(fingerprintInput).digest("hex").slice(0, 24);
  return { version: value.version, fingerprint };
}

export function parseOpenCodeHealth(value: unknown, endpoint: Endpoint): OpenCodeHealth {
  return readHealth(value, endpoint);
}

function mergeDiscoveryOptions(options: ConnectionOptions): DiscoverOptions {
  return {
    ...options.discovery,
    ...(options.version === undefined ? {} : { version: options.version }),
  };
}

function mergeEnsureOptions(options: ConnectionOptions): EnsureOptions {
  return {
    // The beta client's own default still says `opencode`; OC2Token targets
    // the V2 executable explicitly unless the caller supplies a command.
    command: ["opencode2", "serve", "--service"],
    ...options.ensureOptions,
    ...(options.version === undefined ? {} : { version: options.version }),
  };
}

/** Discover a running service, optionally ensuring the V2 service exists. */
export async function connectOpenCode(options: ConnectionOptions = {}): Promise<OpenCodeConnection> {
  const service = options.service ?? defaultService;
  const signal = options.signal;
  throwIfAborted(signal);

  let endpoint = await service.discover(mergeDiscoveryOptions(options));
  throwIfAborted(signal);

  if (endpoint === undefined) {
    if (options.ensure === false) {
      throw new DomainError("transport", "No healthy OpenCode 2 service was discovered");
    }
    endpoint = await service.ensure(mergeEnsureOptions(options));
    throwIfAborted(signal);
  }

  const normalizedEndpoint = assertEndpoint(endpoint);
  const client = options.client ?? (options.clientFactory ?? ((target, factoryOptions) =>
    createOpenCodeClient(target, service, factoryOptions)))(normalizedEndpoint, {
    fetch: options.fetch,
  });

  if (client.health === undefined || typeof client.health.get !== "function") {
    throw new DomainError("invalid-data", "OpenCode client does not expose health.get");
  }

  const health = parseOpenCodeHealth(await client.health.get({ signal }), normalizedEndpoint);
  throwIfAborted(signal);
  return { endpoint: normalizedEndpoint, client, health };
}

/** A class facade is convenient for callers that need to reconnect later. */
export class OpenCodeConnectionManager {
  readonly options: ConnectionOptions;

  constructor(options: ConnectionOptions = {}) {
    this.options = { ...options };
  }

  discover(): Promise<Endpoint | undefined> {
    return (this.options.service ?? defaultService).discover(mergeDiscoveryOptions(this.options));
  }

  ensure(): Promise<Endpoint> {
    return (this.options.service ?? defaultService).ensure(mergeEnsureOptions(this.options));
  }

  connect(): Promise<OpenCodeConnection> {
    return connectOpenCode(this.options);
  }
}
