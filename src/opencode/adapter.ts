import {
  type CollectionRequest,
  type CollectionResult,
  type MessageListRequest,
  type MessagePage,
  type OpenCodeAssistantMessage,
  type OpenCodeSession,
  type OpenCodeSessionStats,
  type OpenCodeTransport,
  type SessionListRequest,
  type SessionPage,
  type UsageSource,
  type UsageStatsRange,
} from "../domain/index.js";
import {
  connectOpenCode,
  defaultService,
  type ConnectionOptions,
  type OpenCodeClientLike,
  type OpenCodeConnection as ClientConnection,
} from "./client.js";
import type { Endpoint } from "@opencode-ai/client/service";
import { runOpenCodeDoctor, type DoctorOptions, type DoctorReport } from "./doctor.js";
import { OpenCodeStatsSource, type OpenCodeStatsSource as StatsSource } from "./stats.js";
import {
  OpenCode2Transport,
  type OpenCodeTransportOptions,
  type StatsRequestOptions,
} from "./transport.js";

export interface OpenCodeAdapterOptions extends ConnectionOptions {
  readonly transport?: OpenCodeTransport;
  readonly pageSize?: number;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitter?: number;
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly requestTimeoutMs?: number;
}

/** Facade that keeps service lifecycle, transport, stats, and diagnostics together. */
export class OpenCode2Adapter implements UsageSource {
  readonly options: OpenCodeAdapterOptions;
  private connection: ClientConnection | undefined;
  private readonly injectedClient: OpenCodeClientLike | undefined;
  private transportValue: OpenCodeTransport | undefined;
  private statsSource: StatsSource | undefined;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.options = { ...options };
    this.injectedClient = options.client;
    this.transportValue = options.transport;
    if (this.transportValue !== undefined) this.statsSource = new OpenCodeStatsSource(this.transportValue);
    else if (this.injectedClient !== undefined) this.installClient(this.injectedClient);
  }

  get currentConnection(): ClientConnection | undefined {
    return this.connection;
  }

  get transport(): OpenCodeTransport | undefined {
    return this.transportValue;
  }

  async connect(signal?: AbortSignal): Promise<ClientConnection> {
    this.connection = await connectOpenCode({
      ...this.options,
      ...(signal === undefined ? {} : { signal }),
    });
    this.installClient(this.connection.client);
    return this.connection;
  }

  async discover(): Promise<Endpoint | undefined> {
    const service = this.options.service;
    return (service ?? defaultService).discover({
      ...this.options.discovery,
      ...(this.options.version === undefined ? {} : { version: this.options.version }),
    });
  }

  async ensure(): Promise<Endpoint> {
    const connection = await connectOpenCode({ ...this.options, ensure: true });
    this.connection = connection;
    this.installClient(connection.client);
    return connection.endpoint;
  }

  private installClient(client: OpenCodeClientLike): void {
    const transportOptions: OpenCodeTransportOptions = {
      client,
      pageSize: this.options.pageSize,
      maxAttempts: this.options.maxAttempts,
      baseDelayMs: this.options.baseDelayMs,
      maxDelayMs: this.options.maxDelayMs,
      jitter: this.options.jitter,
      random: this.options.random,
      sleep: this.options.sleep,
      requestTimeoutMs: this.options.requestTimeoutMs,
    };
    this.transportValue = new OpenCode2Transport(transportOptions);
    this.statsSource = new OpenCodeStatsSource(this.transportValue);
  }

  private requireTransport(): OpenCodeTransport {
    if (this.transportValue === undefined) {
      throw new Error("OpenCode adapter is not connected");
    }
    return this.transportValue;
  }

  getHealth(options: { readonly signal?: AbortSignal } = {}) {
    return this.requireTransport().getHealth(options);
  }

  getSessionStats(window: UsageStatsRange, options: StatsRequestOptions = {}): Promise<OpenCodeSessionStats> {
    const transport = this.requireTransport();
    if (transport instanceof OpenCode2Transport) return transport.getSessionStats(window, options);
    return transport.getSessionStats(window, options);
  }

  listSessions(request: SessionListRequest = {}): Promise<SessionPage> {
    return this.requireTransport().listSessions(request);
  }

  listMessages(request: MessageListRequest): Promise<MessagePage> {
    return this.requireTransport().listMessages(request);
  }

  listAllSessions(options: SessionListRequest & { readonly maxPages?: number } = {}): Promise<ReadonlyArray<OpenCodeSession>> {
    const transport = this.requireTransport();
    if (!(transport instanceof OpenCode2Transport)) {
      throw new Error("listAllSessions requires the OpenCode2Transport pagination implementation");
    }
    return transport.listAllSessions(options);
  }

  listAllMessages(options: MessageListRequest & { readonly maxPages?: number }): Promise<ReadonlyArray<OpenCodeAssistantMessage>> {
    const transport = this.requireTransport();
    if (!(transport instanceof OpenCode2Transport)) {
      throw new Error("listAllMessages requires the OpenCode2Transport pagination implementation");
    }
    return transport.listAllMessages(options);
  }

  collect(request: CollectionRequest): Promise<CollectionResult> {
    if (this.statsSource === undefined) {
      if (this.injectedClient === undefined) {
        return Promise.reject(new Error("OpenCode adapter is not connected"));
      }
      this.installClient(this.injectedClient);
    }
    return this.statsSource!.collect(request);
  }

  doctor(options: Omit<DoctorOptions, "transport" | "connection"> = {}): Promise<DoctorReport> {
    return runOpenCodeDoctor({
      ...options,
      connection: this.connection,
      transport: this.transportValue,
    });
  }
}

export function createOpenCodeAdapter(options: OpenCodeAdapterOptions = {}): OpenCode2Adapter {
  return new OpenCode2Adapter(options);
}
