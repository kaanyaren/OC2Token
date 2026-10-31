/** Internal DeepSeek Harness (dsh) session JSONL types. */

export interface DeepSeekTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

export interface DeepSeekStreamChunk {
  readonly type?: string;
  readonly usage?: DeepSeekTokenUsage;
}

export interface DeepSeekStreamRecord {
  readonly type?: string;
  readonly chunk?: DeepSeekStreamChunk;
}

export interface DeepSeekSessionHeader {
  readonly type: "session";
  readonly version?: number;
  readonly id?: string;
  readonly createdAt?: number;
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly isSeeded?: boolean;
  readonly origin?: string;
  readonly delegationDepth?: number;
}

export interface DeepSeekEntry {
  readonly type?: string;
  readonly seq?: number;
  readonly time?: number;
  readonly data?: Record<string, unknown>;
}

export interface DeepSeekModelCall {
  readonly provider: string;
  readonly model: string;
}
