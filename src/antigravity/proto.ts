/**
 * Pure protobuf utilities for Antigravity SQLite `gen_metadata` parsing.
 *
 * Ported from codeburn 0.9.23 `dist/main.js:16793-17238`
 * (`readProtoVarint`, `parseProtoFields`, `protoTimestampToIso`, etc.)
 * with no `node:sqlite` dependency.
 *
 * Wire types supported: 0 (varint), 2 (len-delimited) required for
 * OC2Token; 1 (64-bit) and 5 (32-bit) also parsed to stay faithful to
 * upstream traversal (they are skipped, not interpreted).
 *
 * Field numbers used (see docs/research/oc2token-antigravity-codex-expansion.md):
 * - root 1 → chat blob
 * - chat 4 → usage blob
 * - usage 1/2 → input tokens (2 preferred, 1 fallback)
 * - usage 3 → total output tokens
 * - usage 9 → response tokens
 * - usage 10 → thinking tokens
 * - usage 11 → responseId
 * - chat 19 → model string
 * - chat 20 → repeated metadata pair {1:key,2:value} (model_enum)
 * - chat 21 → displayName fallback
 * - chat 9.4 → timestamp (proto Timestamp sec/nanos or ISO string)
 */

export interface ProtoField {
  readonly number: number;
  readonly wireType: number;
  readonly value?: bigint;
  readonly bytes?: Uint8Array;
}

const protoTextDecoder = new TextDecoder("utf-8", { fatal: false });

const MODEL_PLACEHOLDER_PATTERN = /^MODEL_PLACEHOLDER_/;

const PRICING_ALIASES: Record<string, string> = {
  "gemini-pro": "gemini-3.1-pro",
};

function dropPlaceholderModelId(model: string): string {
  return MODEL_PLACEHOLDER_PATTERN.test(model) ? "unknown" : model;
}

/**
 * Canonicalize a raw Antigravity model id using optional displayName.
 * Mirrors codeburn `getCanonicalModelId` (0.9.23:16793).
 */
export function getCanonicalModelId(key: string, displayName?: string): string {
  if (displayName) {
    const lower = displayName.toLowerCase();
    if (lower.includes("3.5 flash")) {
      if (lower.includes("high")) return "gemini-3.5-flash-high";
      if (lower.includes("medium")) return "gemini-3.5-flash-medium";
      if (lower.includes("low")) return "gemini-3.5-flash-low";
      return "gemini-3.5-flash";
    }
    if (lower.includes("3.1 pro")) {
      if (lower.includes("high")) return "gemini-3.1-pro-high";
      if (lower.includes("low")) return "gemini-3.1-pro-low";
      return "gemini-3.1-pro";
    }
    if (lower.includes("3.1 flash")) {
      if (lower.includes("image")) return "gemini-3.1-flash-image";
      if (lower.includes("lite")) return "gemini-3.1-flash-lite";
      return "gemini-3.1-flash";
    }
    if (lower.includes("3 flash")) {
      return "gemini-3-flash";
    }
    if (lower.includes("3 pro")) {
      return "gemini-3-pro";
    }
  }
  return dropPlaceholderModelId(key);
}

/**
 * Strip pricing-only suffixes for cost lookup.
 * Mirrors `normalizePricingModel` at codeburn 0.9.23:17110.
 */
export function normalizePricingModel(model: string): string {
  const stripped = model.replace(/-(high|medium|low|agent)$/, "");
  return PRICING_ALIASES[stripped] ?? stripped;
}

/**
 * Read a protobuf varint starting at `startOffset`.
 * Uses BigInt for 70-bit range (codeburn shift >70 guard).
 * Returns `null` on truncation or overflow (mirrors upstream).
 */
export function readProtoVarint(
  data: Uint8Array,
  startOffset: number,
): { value: bigint; offset: number } | null {
  let value = 0n;
  let shift = 0n;
  let offset = startOffset;
  while (offset < data.length) {
    const byte = BigInt(data[offset]!);
    offset += 1;
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) {
      return { value, offset };
    }
    shift += 7n;
    if (shift > 70n) {
      return null;
    }
  }
  return null;
}

/**
 * Parse protobuf fields from `data` until truncation or invalid wire type.
 * Mirrors codeburn `parseProtoFields` (0.9.23:17128). Supports wire types
 * 0, 1, 2, 5 — unknown types break traversal to avoid unbounded skip.
 */
export function parseProtoFields(data: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < data.length) {
    const key = readProtoVarint(data, offset);
    if (key === null) {
      break;
    }
    offset = key.offset;
    const fieldNumber = Number(key.value >> 3n);
    const wireType = Number(key.value & 0x7n);
    if (!Number.isSafeInteger(fieldNumber) || fieldNumber <= 0) {
      break;
    }
    if (wireType === 0) {
      const value = readProtoVarint(data, offset);
      if (value === null) {
        break;
      }
      fields.push({ number: fieldNumber, wireType, value: value.value });
      offset = value.offset;
      continue;
    }
    if (wireType === 1) {
      if (offset + 8 > data.length) break;
      fields.push({ number: fieldNumber, wireType, bytes: data.subarray(offset, offset + 8) });
      offset += 8;
      continue;
    }
    if (wireType === 2) {
      const length = readProtoVarint(data, offset);
      if (length === null) break;
      offset = length.offset;
      const byteLength = Number(length.value);
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || offset + byteLength > data.length) break;
      fields.push({ number: fieldNumber, wireType, bytes: data.subarray(offset, offset + byteLength) });
      offset += byteLength;
      continue;
    }
    if (wireType === 5) {
      if (offset + 4 > data.length) break;
      fields.push({ number: fieldNumber, wireType, bytes: data.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    break;
  }
  return fields;
}

export function firstProtoField(
  fields: readonly ProtoField[],
  fieldNumber: number,
): ProtoField | undefined {
  return fields.find((field) => field.number === fieldNumber);
}

export function protoFieldBytes(field: ProtoField | undefined): Uint8Array | undefined {
  return field?.bytes;
}

export function protoFieldText(field: ProtoField | undefined): string | undefined {
  if (field?.bytes === undefined || field.bytes.length === 0) {
    return undefined;
  }
  const text = protoTextDecoder.decode(field.bytes);
  if (text.length === 0 || /[\u0000-\u0008\u000E-\u001F\u007F\uFFFD]/.test(text)) {
    return undefined;
  }
  return text;
}

export function protoFieldPositiveInteger(field: ProtoField | undefined): number {
  if (field?.value === undefined) {
    return 0;
  }
  const value = Number(field.value);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function isAntigravityResponseId(value: string): boolean {
  return /^[^\s]+$/.test(value);
}

export function antigravitySqliteResponseId(
  usageFields: readonly ProtoField[],
  fallback: string,
): string {
  const responseId = protoFieldText(firstProtoField(usageFields, 11));
  return responseId !== undefined && isAntigravityResponseId(responseId) ? responseId : fallback;
}

export function antigravitySqliteMetadataAttributes(
  chatFields: readonly ProtoField[],
): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const field of chatFields) {
    if (field.number !== 20) {
      continue;
    }
    const pairFields = parseProtoFields(protoFieldBytes(field) ?? new Uint8Array());
    const key = protoFieldText(firstProtoField(pairFields, 1));
    const value = protoFieldText(firstProtoField(pairFields, 2));
    if (key !== undefined && value !== undefined) {
      attributes.set(key, value);
    }
  }
  return attributes;
}

export function antigravitySqliteModel(chatFields: readonly ProtoField[]): string {
  const attributes = antigravitySqliteMetadataAttributes(chatFields);
  const displayName = protoFieldText(firstProtoField(chatFields, 21));
  const rawModel =
    protoFieldText(firstProtoField(chatFields, 19)) ??
    attributes.get("model_enum") ??
    displayName ??
    "unknown";
  return getCanonicalModelId(rawModel, displayName);
}

/**
 * Convert a proto timestamp field to ISO-8601.
 * Handles (in order): ISO string bytes, embedded Timestamp message {1:seconds, 2:nanos}, varint millis/seconds.
 * Mirrors codeburn `protoTimestampToIso` (0.9.23:17215).
 */
export function protoTimestampToIso(field: ProtoField | undefined): string {
  if (field === undefined) {
    return "";
  }
  const text = protoFieldText(field);
  if (text !== undefined && !Number.isNaN(Date.parse(text))) {
    return new Date(text).toISOString();
  }
  if (field.bytes !== undefined) {
    const tsFields = parseProtoFields(field.bytes);
    const seconds = firstProtoField(tsFields, 1)?.value;
    if (seconds !== undefined) {
      const nanos = firstProtoField(tsFields, 2)?.value ?? 0n;
      const ms = Number(seconds) * 1_000 + Math.floor(Number(nanos) / 1_000_000);
      if (Number.isSafeInteger(ms) && ms > 0) {
        return new Date(ms).toISOString();
      }
    }
  }
  if (field.value !== undefined) {
    const raw = Number(field.value);
    const ms = raw < 1e12 ? raw * 1_000 : raw;
    if (Number.isSafeInteger(ms) && ms > 0) {
      return new Date(ms).toISOString();
    }
  }
  return "";
}

/**
 * Extract created-at ISO string from chat fields (chat.field9.field4).
 * Returns "" when absent — caller may fallback to file mtime.
 */
export function antigravitySqliteCreatedAt(chatFields: readonly ProtoField[]): string {
  const metadataBytes = protoFieldBytes(firstProtoField(chatFields, 9));
  if (metadataBytes === undefined) {
    return "";
  }
  return protoTimestampToIso(firstProtoField(parseProtoFields(metadataBytes), 4));
}
