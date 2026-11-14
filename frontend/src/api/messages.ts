// User-facing copy for every error code and field issue in errors.md.
// The Record types make this exhaustive: a code added to the contract (and so
// to schema.gen.ts) fails typecheck until it has copy here.
import type { ClientError } from "./errors.ts";
import type { ErrorCode, FieldError, FieldIssue } from "./types.ts";

export interface ErrorCopy {
  message: string;
  /** Offer "Try again" (input is always kept either way). */
  retryable: boolean;
  /** Show the request ID and "Copy diagnostics" (errors.md "Client handling"). */
  diagnostics: boolean;
}

const copy = (
  message: string,
  retryable = false,
  diagnostics = false,
): ErrorCopy => ({
  message,
  retryable,
  diagnostics,
});

export const ERROR_COPY: Record<ErrorCode, ErrorCopy> = {
  VALIDATION_FAILED: copy(
    "Some details need fixing. Check the highlighted fields.",
  ),
  INVITATION_INVALID: copy(
    "This invitation is no longer valid. Ask the person who invited you for a new one.",
  ),
  TOKEN_INVALID: copy(
    "This link has expired or was already used. Request a new one.",
  ),
  UNAUTHENTICATED: copy("You're signed out. Sign in to continue."),
  INVALID_CREDENTIALS: copy("That email and password don't match. Try again."),
  MFA_REQUIRED: copy("Confirm it's you with your second factor to continue."),
  MFA_FAILED: copy("That code didn't work. Check it and try again."),
  CSRF_FAILED: copy(
    "Your session couldn't be verified. Reload the page and try again.",
    false,
    true,
  ),
  FORBIDDEN: copy("Only the budget owner can do that."),
  REAUTH_REQUIRED: copy("Confirm your password to continue."),
  ACCOUNT_PENDING_DELETION: copy(
    "Your account is scheduled for deletion. Cancel the deletion to keep using Shoestring.",
  ),
  NOT_FOUND: copy("This doesn't exist, or you don't have access to it."),
  VERSION_CONFLICT: copy(
    "Someone else changed this while you were editing. Review the latest version.",
  ),
  ALREADY_EXISTS: copy("That already exists."),
  CATEGORY_IN_USE: copy(
    "This category has transactions, so it can't be deleted. Archive it instead.",
  ),
  OWNER_CANNOT_LEAVE: copy(
    "Transfer ownership to another member before you leave this budget.",
  ),
  OWNS_SHARED_BUDGET: copy(
    "You own a shared budget. Transfer ownership, remove its members or delete it first.",
  ),
  MFA_NOT_ENABLED: copy("Set up two-step verification first."),
  PAYLOAD_TOO_LARGE: copy(
    "That's too much to send at once. Shorten it and try again.",
    false,
    true,
  ),
  UNSUPPORTED_MEDIA_TYPE: copy(
    "Something went wrong sending that. Reload and try again.",
    false,
    true,
  ),
  SPLITS_DO_NOT_SUM: copy("The splits must add up to the total amount."),
  CATEGORY_ARCHIVED: copy("That category is archived. Choose another one."),
  IDEMPOTENCY_KEY_REUSED: copy(
    "This entry changed after it was first sent. Check it and save again.",
  ),
  LIMIT_REACHED: copy("You've reached the limit for this."),
  RATE_LIMITED: copy("Too many attempts. Wait a moment and try again.", true),
  INTERNAL: copy(
    "Something went wrong on our side. Nothing you typed was lost.",
    true,
    true,
  ),
  UNAVAILABLE: copy(
    "Shoestring is temporarily unavailable. Nothing you typed was lost.",
    true,
    true,
  ),
};

export const NETWORK_COPY = copy(
  "You're offline or the connection dropped. Nothing you typed was lost.",
  true,
);

export const UNEXPECTED_COPY = copy(
  "Something went wrong. Nothing you typed was lost.",
  true,
  true,
);

export const FIELD_ISSUE_COPY: Record<FieldIssue, string> = {
  required: "Required.",
  unknown_field: "This field isn't accepted.",
  invalid_type: "This isn't in the right format.",
  invalid_format: "This isn't in the right format.",
  invalid_value: "This value isn't allowed.",
  too_small: "This is too small.",
  too_big: "This is too large.",
  too_short: "This is too short.",
  too_long: "This is too long.",
  breached_password:
    "This password has appeared in a data breach. Choose a different one.",
  duplicate: "This is a duplicate.",
  sum_mismatch: "The splits must add up to the total.",
  archived: "This category is archived.",
  already_member: "This person is already a member.",
  invitation_pending: "An invitation is already pending for this email.",
  limit: "You've reached the limit for this.",
};

export const GENERIC_FIELD_COPY = "This isn't valid.";

/** "about 2 minutes" style wait text for Retry-After. */
export function formatWait(seconds: number): string {
  if (seconds < 60) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

export interface DescribedError extends ErrorCopy {
  /** For "Copy diagnostics"; null when the request never reached the server. */
  requestId: string | null;
}

/** One message for any client error, ready for an alert or toast. */
export function describeError(error: ClientError): DescribedError {
  switch (error.kind) {
    case "network":
      return { ...NETWORK_COPY, requestId: null };
    case "unexpected":
      return { ...UNEXPECTED_COPY, requestId: error.requestId };
    case "api": {
      const base = ERROR_COPY[error.code];
      const message =
        error.code === "RATE_LIMITED" && error.retryAfterSeconds !== null
          ? `Too many attempts. Try again in ${formatWait(error.retryAfterSeconds)}.`
          : base.message;
      return { ...base, message, requestId: error.requestId };
    }
  }
}

export interface MappedFieldErrors {
  /** First message per known form field, keyed by the contract field path. */
  fields: Partial<Record<string, string>>;
  /** Details that match no field on the form: show as a form-level message. */
  form: string[];
}

/**
 * Maps FieldError details (VALIDATION_FAILED, and 409/422 codes that point at
 * a field) onto a form's fields by `field` path. Body fields only; header,
 * query and path details are form-level.
 */
export function mapFieldErrors(
  details: readonly FieldError[],
  knownFields: readonly string[],
  overrides: Partial<Record<FieldIssue, string>> = {},
): MappedFieldErrors {
  const known = new Set(knownFields);
  const result: MappedFieldErrors = { fields: {}, form: [] };
  for (const detail of details) {
    // An issue code newer than this build still gets a readable message.
    const text =
      overrides[detail.issue] ??
      (Object.hasOwn(FIELD_ISSUE_COPY, detail.issue)
        ? FIELD_ISSUE_COPY[detail.issue]
        : GENERIC_FIELD_COPY);
    if (detail.in === "body" && known.has(detail.field)) {
      result.fields[detail.field] ??= text;
    } else if (!result.form.includes(text)) {
      result.form.push(text);
    }
  }
  return result;
}
