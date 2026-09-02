/**
 * Internal Codex JSONL types. Not part of public domain contracts.
 */

export interface CodexRawUsage {
  readonly input_tokens?: number;
  readonly cached_input_tokens?: number;
  readonly cache_write_input_tokens?: number;
  readonly output_tokens?: number;
  readonly reasoning_output_tokens?: number;
  readonly total_tokens?: number;
}

export interface CodexInfo {
  readonly last_token_usage?: CodexRawUsage | null;
  readonly total_token_usage?: CodexRawUsage | null;
  readonly model?: string;
  readonly model_name?: string;
}

export interface CodexEventPayload {
  readonly type?: string;
  readonly info?: CodexInfo;
  readonly model?: string;
  readonly model_name?: string;
  readonly session_id?: string;
  readonly cwd?: string;
  readonly forked_from_id?: string;
}

export interface CodexEntry {
  readonly type: string;
  readonly timestamp?: string;
  readonly payload?: CodexEventPayload | Record<string, unknown>;
}
