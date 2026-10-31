/** Internal Pi session JSONL types. Not part of public domain contracts. */

export interface PiUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cacheWrite1h?: number;
  readonly reasoning?: number;
  readonly totalTokens?: number;
  readonly cost?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly total?: number;
  };
}

export interface PiMessage {
  readonly role?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly usage?: PiUsage | null;
  readonly timestamp?: number;
  readonly stopReason?: string;
}

export interface PiSessionHeader {
  readonly type: "session";
  readonly version?: number;
  readonly id?: string;
  readonly timestamp?: string | number;
  readonly cwd?: string;
  readonly parentSession?: string;
}

export interface PiEntry {
  readonly type?: string;
  readonly id?: string;
  readonly timestamp?: string | number;
  readonly kind?: string;
  readonly provider?: string;
  readonly modelId?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly usage?: PiUsage | null;
  readonly message?: PiMessage;
}
