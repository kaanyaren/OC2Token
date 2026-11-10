import { OpenCode } from "@opencode-ai/client";
import { headers as serviceHeaders, type Endpoint } from "@opencode-ai/client/service";
import { discoverNativeEndpoint } from "./native.js";

export interface LiveTpsEvent {
  readonly type: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface LiveTpsReading {
  readonly tps: number;
  readonly activeSessions: number;
}

export interface LiveTpsSnapshot extends LiveTpsReading {
  readonly available: boolean;
}

export interface LiveTpsMeter {
  start(): void;
  stop(): void;
  snapshot(now?: number): LiveTpsSnapshot;
}

export interface LiveTpsMeterOptions {
  readonly discover?: (signal?: AbortSignal) => Promise<Endpoint | undefined>;
}

const WINDOW_MS = 1_000;
const PRUNE_MS = 30_000;
const CHARS_PER_TOKEN = 4;
const MIN_FACTOR = 0.5;
const MAX_FACTOR = 2;
const MIN_CALIBRATION_TOKENS = 10;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 5_000;

interface Sample {
  readonly at: number;
  readonly tokens: number;
}

interface SessionState {
  samples: Sample[];
  factor: number;
  stepTokens: number;
  toolChars: Map<string, number>;
  lastSeen: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Heuristic live rate from streamed characters; exact counts only arrive per step. */
export class TpsAggregator {
  private readonly sessions = new Map<string, SessionState>();

  reset(): void {
    this.sessions.clear();
  }

  ingest(event: LiveTpsEvent, now: number): void {
    const data = asRecord(event.data);
    if (data === undefined) return;
    const sessionID = asString(data.sessionID);
    if (sessionID.length === 0) return;
    const type = event.type;

    if (type === "session.idle") {
      this.sessions.delete(sessionID);
      return;
    }

    if (type === "session.step.started") {
      const session = this.session(sessionID, now);
      session.stepTokens = 0;
      session.toolChars.clear();
      return;
    }

    if (type === "session.step.ended") {
      const session = this.sessions.get(sessionID);
      if (session === undefined) return;
      const tokens = asRecord(data.tokens);
      const providerTokens = tokens === undefined ? 0 : asNumber(tokens.output) + asNumber(tokens.reasoning);
      if (providerTokens > 0 && session.stepTokens >= MIN_CALIBRATION_TOKENS) {
        session.factor = clamp(providerTokens / session.stepTokens, MIN_FACTOR, MAX_FACTOR);
      }
      session.stepTokens = 0;
      session.toolChars.clear();
      return;
    }

    if (type === "session.text.delta" || type === "session.reasoning.delta") {
      this.addChars(sessionID, asString(data.delta).length, now);
      return;
    }

    if (type === "session.tool.input.delta") {
      const key = toolKey(data);
      if (key === undefined) return;
      const session = this.session(sessionID, now);
      const added = asString(data.delta).length;
      if (added > 0) {
        session.toolChars.set(key, (session.toolChars.get(key) ?? 0) + added);
        this.addChars(sessionID, added, now);
      }
      return;
    }

    if (type === "session.tool.input.ended") {
      const key = toolKey(data);
      if (key === undefined) return;
      const session = this.session(sessionID, now);
      const text = asString(data.text);
      const counted = session.toolChars.get(key) ?? 0;
      session.toolChars.delete(key);
      // Some servers emit only the completed tool input, not incremental deltas.
      if (text.length > counted) this.addChars(sessionID, text.length - counted, now);
    }
  }

  snapshot(now: number): LiveTpsReading {
    const cutoff = now - WINDOW_MS;
    let tokens = 0;
    let activeSessions = 0;
    for (const [sessionID, session] of this.sessions) {
      while (session.samples.length > 0 && session.samples[0]!.at <= cutoff) {
        session.samples.shift();
      }
      if (session.samples.length > 0) {
        activeSessions += 1;
        for (const sample of session.samples) tokens += sample.tokens;
      }
      if (now - session.lastSeen > PRUNE_MS) this.sessions.delete(sessionID);
    }
    return { tps: tokens / (WINDOW_MS / 1_000), activeSessions };
  }

  private session(sessionID: string, now: number): SessionState {
    let session = this.sessions.get(sessionID);
    if (session === undefined) {
      session = {
        samples: [],
        factor: 1,
        stepTokens: 0,
        toolChars: new Map(),
        lastSeen: now,
      };
      this.sessions.set(sessionID, session);
    }
    session.lastSeen = now;
    return session;
  }

  private addChars(sessionID: string, chars: number, now: number): void {
    if (chars <= 0) return;
    const session = this.session(sessionID, now);
    const rawTokens = chars / CHARS_PER_TOKEN;
    session.stepTokens += rawTokens;
    session.samples.push({ at: now, tokens: rawTokens * session.factor });
  }
}

function toolKey(data: Readonly<Record<string, unknown>>): string | undefined {
  const id = asString(data.id);
  if (id.length === 0) return undefined;
  return `${asString(data.assistantMessageID)}:${id}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
    // Close the race between the initial check and listener registration.
    if (signal.aborted) onAbort();
  });
}

/**
 * Follow OpenCode2's global event stream. One local service backs every TUI
 * window, so this one subscription sees every active session. The number is an
 * estimate: live text deltas are the only real-time signal the server exposes.
 */
export function createLiveTpsMeter(options: LiveTpsMeterOptions = {}): LiveTpsMeter {
  const aggregator = new TpsAggregator();
  const discover =
    options.discover ?? ((signal?: AbortSignal) => discoverNativeEndpoint(signal === undefined ? {} : { signal }));
  let running = false;
  let available = false;
  let lifecycle: AbortController | undefined;
  let subscription: AbortController | undefined;

  async function run(): Promise<void> {
    let delay = RECONNECT_BASE_MS;
    const signal = lifecycle!.signal;
    while (running) {
      subscription = new AbortController();
      try {
        const endpoint = await discover(signal);
        if (endpoint === undefined) throw new Error("OpenCode 2 service not found");
        const client = OpenCode.make({
          baseUrl: endpoint.url,
          headers: serviceHeaders(endpoint) ?? {},
        });
        aggregator.reset();
        for await (const event of client.event.subscribe({ signal: subscription.signal })) {
          if (!running) break;
          available = true;
          delay = RECONNECT_BASE_MS;
          aggregator.ingest(event as LiveTpsEvent, Date.now());
        }
      } catch {
        // A dropped service is expected during restarts; reconnect below.
      }
      available = false;
      subscription = undefined;
      if (!running) break;
      await sleep(delay, signal);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      lifecycle = new AbortController();
      void run();
    },
    stop(): void {
      if (!running) return;
      running = false;
      lifecycle?.abort();
      subscription?.abort();
      aggregator.reset();
      available = false;
    },
    snapshot(now = Date.now()): LiveTpsSnapshot {
      return { available, ...aggregator.snapshot(now) };
    },
  };
}
