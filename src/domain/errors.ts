/** Codes used when a domain value cannot be trusted or a collection cannot finish. */
export type CollectionErrorCode =
  | "cancelled"
  | "authentication"
  | "rate-limited"
  | "transport"
  | "protocol"
  | "invalid-data"
  | "cache-busy"
  | "cache-unavailable"
  | "cache-corrupt"
  | "unknown";

export type DomainErrorCode =
  | CollectionErrorCode
  | "invalid-date"
  | "invalid-timezone"
  | "invalid-window"
  | "missing-token-components"
  | "invalid-token-components"
  | "invalid-usage-record"
  | "invalid-snapshot";

export interface DomainErrorOptions {
  readonly retryable?: boolean;
  readonly sessionID?: string;
  readonly cause?: unknown;
}

/** A typed error that adapters and callers can classify without parsing text. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly retryable: boolean;
  readonly sessionID: string | undefined;

  constructor(code: DomainErrorCode, message: string, options: DomainErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "DomainError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.sessionID = options.sessionID;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface CollectionError {
  readonly code: CollectionErrorCode;
  readonly message: string;
  readonly sessionID?: string;
  readonly retryable: boolean;
}

export function cancellationError(message = "The operation was cancelled"): DomainError {
  return new DomainError("cancelled", message, { retryable: false });
}

export function isCancellationError(error: unknown): boolean {
  if (error instanceof DomainError) {
    return error.code === "cancelled";
  }

  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "CanceledError";
  }

  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    return code === "ABORT_ERR" || code === "ERR_CANCELED";
  }

  return false;
}

const COLLECTION_ERROR_CODES: ReadonlySet<CollectionErrorCode> = new Set([
  "cancelled",
  "authentication",
  "rate-limited",
  "transport",
  "protocol",
  "invalid-data",
  "cache-busy",
  "cache-unavailable",
  "cache-corrupt",
  "unknown",
]);

function isCollectionErrorCode(code: DomainErrorCode): code is CollectionErrorCode {
  return COLLECTION_ERROR_CODES.has(code as CollectionErrorCode);
}

/** Convert an adapter failure into the bounded error shape carried by Coverage. */
export function toCollectionError(
  error: unknown,
  fallbackCode: CollectionErrorCode = "unknown",
  sessionID?: string,
): CollectionError {
  if (error instanceof DomainError && isCollectionErrorCode(error.code)) {
    return {
      code: error.code,
      message: error.message,
      ...(error.sessionID === undefined && sessionID === undefined
        ? {}
        : { sessionID: error.sessionID ?? sessionID }),
      retryable: error.retryable,
    };
  }

  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    ...(sessionID === undefined ? {} : { sessionID }),
    retryable: false,
  };
}
