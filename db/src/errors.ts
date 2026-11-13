// Typed errors for the backend. Each `code` is the errors.md code the backend
// should answer with (one code = one HTTP status). Messages are fixed, safe
// English: they never contain submitted values, emails, amounts or names.

export type DalErrorCode =
  | "VALIDATION_FAILED"
  | "INVITATION_INVALID"
  | "TOKEN_INVALID"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "ALREADY_EXISTS"
  | "CATEGORY_IN_USE"
  | "OWNER_CANNOT_LEAVE"
  | "OWNS_SHARED_BUDGET"
  | "MFA_NOT_ENABLED"
  | "SPLITS_DO_NOT_SUM"
  | "CATEGORY_ARCHIVED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "LIMIT_REACHED"
  | "RATE_LIMITED";

/** Mirrors errors.md FieldError (the backend adds `message`). */
export interface DalFieldIssue {
  in: "body" | "path" | "query" | "header";
  field: string;
  issue:
    | "required"
    | "invalid_format"
    | "invalid_value"
    | "too_small"
    | "too_big"
    | "too_short"
    | "too_long"
    | "duplicate"
    | "sum_mismatch"
    | "archived"
    | "already_member"
    | "invitation_pending"
    | "limit";
}

const MESSAGES: Record<DalErrorCode, string> = {
  VALIDATION_FAILED: "Some fields are invalid.",
  INVITATION_INVALID: "This invitation is no longer valid.",
  TOKEN_INVALID: "This link is invalid or has expired.",
  FORBIDDEN: "You are not allowed to do this.",
  NOT_FOUND: "Not found.",
  VERSION_CONFLICT: "This was changed by someone else.",
  ALREADY_EXISTS: "This already exists.",
  CATEGORY_IN_USE: "This category is used by transactions.",
  OWNER_CANNOT_LEAVE: "Transfer ownership before leaving.",
  OWNS_SHARED_BUDGET: "You still own a shared budget.",
  MFA_NOT_ENABLED: "Two-factor authentication is not enabled.",
  SPLITS_DO_NOT_SUM: "Splits do not add up to the amount.",
  CATEGORY_ARCHIVED: "This category is archived.",
  IDEMPOTENCY_KEY_REUSED:
    "This Idempotency-Key was used for a different request.",
  LIMIT_REACHED: "A limit was reached.",
  RATE_LIMITED: "Too many requests.",
};

export class DalError extends Error {
  override readonly name = "DalError";
  readonly code: DalErrorCode;
  readonly details: readonly DalFieldIssue[];
  /** RATE_LIMITED only: seconds until the caller may retry (Retry-After). */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: DalErrorCode,
    options: { details?: DalFieldIssue[]; retryAfterSeconds?: number } = {},
  ) {
    super(MESSAGES[code]);
    this.code = code;
    this.details = Object.freeze([...(options.details ?? [])]);
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function isDalError(e: unknown): e is DalError {
  return e instanceof DalError;
}

export const notFound = (): DalError => new DalError("NOT_FOUND");
export const forbidden = (): DalError => new DalError("FORBIDDEN");
export const versionConflict = (): DalError =>
  new DalError("VERSION_CONFLICT", {
    details: [{ in: "body", field: "version", issue: "invalid_value" }],
  });
export const limitReached = (field = ""): DalError =>
  new DalError("LIMIT_REACHED", {
    details: [{ in: "body", field, issue: "limit" }],
  });
export const invalid = (issue: DalFieldIssue): DalError =>
  new DalError("VALIDATION_FAILED", { details: [issue] });

/** SQLSTATE and constraint of a driver error, without touching its message. */
export function pgErrorInfo(e: unknown): {
  code?: string;
  constraint?: string;
} {
  if (typeof e === "object" && e !== null) {
    const o = e as { code?: unknown; constraint?: unknown };
    return {
      ...(typeof o.code === "string" ? { code: o.code } : {}),
      ...(typeof o.constraint === "string" ? { constraint: o.constraint } : {}),
    };
  }
  return {};
}

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const info = pgErrorInfo(e);
  return (
    info.code === "23505" &&
    (constraint === undefined || info.constraint === constraint)
  );
}

export function isForeignKeyViolation(
  e: unknown,
  constraint?: string,
): boolean {
  const info = pgErrorInfo(e);
  return (
    info.code === "23503" &&
    (constraint === undefined || info.constraint === constraint)
  );
}
