// Typed client errors. Every non-2xx /api response is an ErrorBody
// (errors.md); clients switch on `code`, never on `message` or status alone.
import { ERROR_COPY } from "./messages.ts";
import type { ErrorBody, ErrorCode, FieldError } from "./types.ts";

/** The server answered with an ErrorBody. */
export class ApiError extends Error {
  readonly kind = "api";
  readonly status: number;
  readonly code: ErrorCode;
  readonly requestId: string;
  readonly details: readonly FieldError[];
  /** Seconds from Retry-After (429, some 503), or null. */
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    body: ErrorBody,
    retryAfterSeconds: number | null,
  ) {
    super(body.code);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code;
    this.requestId = body.requestId;
    this.details = body.details ?? [];
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The request never got an HTTP response (offline, DNS, connection reset). */
export class NetworkError extends Error {
  readonly kind = "network";
  constructor(options?: { cause?: unknown }) {
    super("Network request failed", options);
    this.name = "NetworkError";
  }
}

/**
 * An HTTP error that is not an ErrorBody (for example a proxy's HTML 502 page).
 * Treated like a temporary outage.
 */
export class UnexpectedResponseError extends Error {
  readonly kind = "unexpected";
  readonly status: number;
  readonly requestId: string | null;
  constructor(status: number, requestId: string | null) {
    super(`Unexpected response (HTTP ${status})`);
    this.name = "UnexpectedResponseError";
    this.status = status;
    this.requestId = requestId;
  }
}

export type ClientError = ApiError | NetworkError | UnexpectedResponseError;

export function isClientError(error: unknown): error is ClientError {
  return (
    error instanceof ApiError ||
    error instanceof NetworkError ||
    error instanceof UnexpectedResponseError
  );
}

const FIELD_LOCATIONS = new Set(["body", "query", "path", "header"]);

function isFieldError(value: unknown): value is FieldError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.in === "string" &&
    FIELD_LOCATIONS.has(v.in) &&
    typeof v.field === "string" &&
    typeof v.issue === "string" &&
    typeof v.message === "string"
  );
}

/** Runtime check that a parsed error body is a contract ErrorBody. */
export function isErrorBody(value: unknown): value is ErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === "string" &&
    Object.hasOwn(ERROR_COPY, v.code) &&
    typeof v.message === "string" &&
    typeof v.requestId === "string" &&
    (v.details === undefined ||
      (Array.isArray(v.details) && v.details.every(isFieldError)))
  );
}

/** Retry-After as whole seconds (the contract uses delta-seconds only). */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return null;
  const seconds = Number(value.trim());
  return seconds > 0 ? seconds : null;
}
