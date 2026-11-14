// The one error format (errors.md): every non-2xx /api response is an
// ErrorBody { code, message, requestId, details? }. One code = one status.
// Messages are fixed, safe English and never contain submitted values.
import { isDalError } from "@shoestring/db";

export const ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  INVITATION_INVALID: 400,
  TOKEN_INVALID: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  MFA_REQUIRED: 401,
  MFA_FAILED: 401,
  CSRF_FAILED: 403,
  FORBIDDEN: 403,
  REAUTH_REQUIRED: 403,
  ACCOUNT_PENDING_DELETION: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  ALREADY_EXISTS: 409,
  CATEGORY_IN_USE: 409,
  OWNER_CANNOT_LEAVE: 409,
  OWNS_SHARED_BUDGET: 409,
  MFA_NOT_ENABLED: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  SPLITS_DO_NOT_SUM: 422,
  CATEGORY_ARCHIVED: 422,
  IDEMPOTENCY_KEY_REUSED: 422,
  LIMIT_REACHED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_FAILED: "Some fields are invalid.",
  INVITATION_INVALID: "This invitation is no longer valid.",
  TOKEN_INVALID: "This link is invalid or has expired.",
  UNAUTHENTICATED: "You are signed out.",
  INVALID_CREDENTIALS: "The email or password is incorrect.",
  MFA_REQUIRED: "A second factor is required.",
  MFA_FAILED: "The second factor is incorrect.",
  CSRF_FAILED: "The request was refused.",
  FORBIDDEN: "You are not allowed to do this.",
  REAUTH_REQUIRED: "Please confirm your password to continue.",
  ACCOUNT_PENDING_DELETION: "Your account is scheduled for deletion.",
  NOT_FOUND: "Not found.",
  VERSION_CONFLICT: "This was changed by someone else.",
  ALREADY_EXISTS: "This already exists.",
  CATEGORY_IN_USE: "This category is used by transactions.",
  OWNER_CANNOT_LEAVE: "Transfer ownership before leaving.",
  OWNS_SHARED_BUDGET: "You still own a shared budget.",
  MFA_NOT_ENABLED: "Two-factor authentication is not enabled.",
  PAYLOAD_TOO_LARGE: "The request is too large.",
  UNSUPPORTED_MEDIA_TYPE: "The request must be JSON.",
  SPLITS_DO_NOT_SUM: "Splits do not add up to the amount.",
  CATEGORY_ARCHIVED: "This category is archived.",
  IDEMPOTENCY_KEY_REUSED:
    "This Idempotency-Key was used for a different request.",
  LIMIT_REACHED: "A limit was reached.",
  RATE_LIMITED: "Too many requests. Try again later.",
  INTERNAL: "Something went wrong.",
  UNAVAILABLE: "The service is temporarily unavailable.",
};

export type FieldLocation = "body" | "query" | "path" | "header";

export type FieldIssue =
  | "required"
  | "unknown_field"
  | "invalid_type"
  | "invalid_format"
  | "invalid_value"
  | "too_small"
  | "too_big"
  | "too_short"
  | "too_long"
  | "breached_password"
  | "duplicate"
  | "sum_mismatch"
  | "archived"
  | "already_member"
  | "invitation_pending"
  | "limit";

export interface FieldError {
  in: FieldLocation;
  field: string;
  issue: FieldIssue;
  message: string;
}

export const ISSUE_MESSAGES: Record<FieldIssue, string> = {
  required: "This field is required.",
  unknown_field: "This field is not allowed.",
  invalid_type: "This field has the wrong type.",
  invalid_format: "This field has an invalid format.",
  invalid_value: "This value is not allowed.",
  too_small: "This value is too small.",
  too_big: "This value is too large.",
  too_short: "This value is too short.",
  too_long: "This value is too long.",
  breached_password:
    "This password appears in a list of breached passwords. Choose another.",
  duplicate: "This value is a duplicate.",
  sum_mismatch: "The splits must add up to the amount.",
  archived: "This category is archived.",
  already_member: "This person is already a member.",
  invitation_pending: "An invitation is already pending for this email.",
  limit: "A limit was reached.",
};

export function fieldError(
  where: FieldLocation,
  field: string,
  issue: FieldIssue,
): FieldError {
  return { in: where, field, issue, message: ISSUE_MESSAGES[issue] };
}

export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: readonly FieldError[] | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ErrorCode,
    options: { details?: FieldError[]; retryAfterSeconds?: number } = {},
  ) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details =
      options.details && options.details.length > 0
        ? options.details.slice(0, 50)
        : undefined;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function validationFailed(details: FieldError[]): ApiError {
  return new ApiError("VALIDATION_FAILED", {
    details:
      details.length > 0 ? details : [fieldError("body", "", "invalid_value")],
  });
}

/** DalError -> ApiError (DAL codes are errors.md codes; the backend adds messages). */
export function fromDalError(e: unknown): ApiError | null {
  if (!isDalError(e)) return null;
  const details = e.details.map((d) => fieldError(d.in, d.field, d.issue));
  if (e.code === "VALIDATION_FAILED") return validationFailed(details);
  return new ApiError(e.code, {
    details,
    ...(e.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: e.retryAfterSeconds }
      : {}),
  });
}

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  requestId: string;
  details?: FieldError[];
}

export function toErrorBody(err: ApiError, requestId: string): ErrorBody {
  return {
    code: err.code,
    message: ERROR_MESSAGES[err.code],
    requestId,
    ...(err.details ? { details: [...err.details] } : {}),
  };
}
