import { DomainError } from "./errors.js";

export const TOKEN_COMPONENT_NAMES = [
  "input",
  "output",
  "reasoning",
  "cacheRead",
  "cacheWrite",
] as const;

export type TokenComponentName = (typeof TOKEN_COMPONENT_NAMES)[number];

/** Normalized non-negative token counts. Raw API objects must be parsed first. */
export interface TokenComponents {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface UsageTotals extends TokenComponents {
  readonly recorded_total: number;
}

/**
 * The transport adapter may receive either OpenCode's nested cache shape or an
 * already flattened shape. Once normalized, all five fields are present.
 *
 * A present token object may omit fields; omitted component fields mean zero.
 * An absent token object is represented by `undefined` and is not accepted by
 * `parseTokenComponents`, because absence is not evidence of a zero-token
 * completed message.
 */
export interface TokenComponentsInput {
  readonly input?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly cache?: {
    readonly read?: number;
    readonly write?: number;
  };
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

export type TokenValidationResult =
  | { readonly ok: true; readonly value: TokenComponents }
  | { readonly ok: false; readonly error: DomainError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonNegativeInteger(
  value: unknown,
  path: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(
      "invalid-token-components",
      `${path} must be a finite non-negative safe integer`,
    );
  }

  return value;
}

function readOptionalComponent(
  record: Record<string, unknown>,
  name: string,
): number {
  return name in record ? readNonNegativeInteger(record[name], name) : 0;
}

function readCacheComponent(
  cache: Record<string, unknown>,
  name: "read" | "write",
): number {
  return name in cache
    ? readNonNegativeInteger(cache[name], `cache.${name}`)
    : 0;
}

/** Parse and validate an OpenCode-shaped token object. */
export function parseTokenComponents(value: unknown): TokenComponents {
  if (value === undefined || value === null) {
    throw new DomainError(
      "missing-token-components",
      "A usage-bearing message must contain a token components object",
    );
  }

  if (!isRecord(value)) {
    throw new DomainError(
      "invalid-token-components",
      "Token components must be an object",
    );
  }

  const input = readOptionalComponent(value, "input");
  const output = readOptionalComponent(value, "output");
  const reasoning = readOptionalComponent(value, "reasoning");

  let cacheRead = readOptionalComponent(value, "cacheRead");
  let cacheWrite = readOptionalComponent(value, "cacheWrite");

  if ("cache" in value) {
    if (!isRecord(value.cache)) {
      throw new DomainError(
        "invalid-token-components",
        "cache must be an object when present",
      );
    }

    const nestedRead = readCacheComponent(value.cache, "read");
    const nestedWrite = readCacheComponent(value.cache, "write");

    if ("cacheRead" in value && nestedRead !== cacheRead) {
      throw new DomainError(
        "invalid-token-components",
        "cache.read and cacheRead disagree",
      );
    }
    if ("cacheWrite" in value && nestedWrite !== cacheWrite) {
      throw new DomainError(
        "invalid-token-components",
        "cache.write and cacheWrite disagree",
      );
    }

    cacheRead = nestedRead;
    cacheWrite = nestedWrite;
  }

  return { input, output, reasoning, cacheRead, cacheWrite };
}

/** Return a non-throwing validation result for transport and boundary code. */
export function validateTokenComponents(value: unknown): TokenValidationResult {
  try {
    return { ok: true, value: parseTokenComponents(value) };
  } catch (error) {
    if (error instanceof DomainError) {
      return { ok: false, error };
    }

    return {
      ok: false,
      error: new DomainError(
        "invalid-token-components",
        "Token components could not be validated",
        { cause: error },
      ),
    };
  }
}

/**
 * Strict type guard for already-normalized values.
 *
 * This is intentionally stricter than {@link parseTokenComponents}, which is
 * the lenient ingestion path: parse accepts a present object with omitted
 * fields (omitted means zero) and accepts either the nested `cache.read/write`
 * shape or the flattened `cacheRead/cacheWrite` shape. `isTokenComponents`
 * instead requires all five flattened fields to already be present as
 * non-negative safe integers. Extra fields (including a nested `cache` object)
 * are ignored: a normalized value stays normalized even if the raw payload
 * retained provider-specific extras.
 */
export function isTokenComponents(value: unknown): value is TokenComponents {
  if (!isRecord(value)) return false;
  for (const name of TOKEN_COMPONENT_NAMES) {
    const candidate = value[name];
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
      return false;
    }
  }
  return true;
}

/** Calculate the explicitly named accounting sum; this is not a billing total. */
export function recorded_total(components: TokenComponents): number {
  const normalized = parseTokenComponents(components);
  const total = TOKEN_COMPONENT_NAMES.reduce(
    (sum, name) => sum + normalized[name],
    0,
  );

  if (!Number.isSafeInteger(total)) {
    throw new DomainError(
      "invalid-token-components",
      "recorded_total exceeds the safe integer range",
    );
  }

  return total;
}

export const recordedTotal = recorded_total;

export function toUsageTotals(components: TokenComponents): UsageTotals {
  const normalized = parseTokenComponents(components);
  return { ...normalized, recorded_total: recorded_total(normalized) };
}

export const sumTokenComponents = toUsageTotals;
