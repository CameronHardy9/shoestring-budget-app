// Request validation (errors.md check-order step 6). zod schemas reject unknown
// fields; issues map to FieldError {in, field, issue, message}. Messages are
// fixed per issue and never echo the submitted value.
import { isCalendarDate, isValidTimeZone } from "@shoestring/db";
import { z } from "zod";
import type { FieldError, FieldIssue, FieldLocation } from "../errors.ts";
import { fieldError, validationFailed } from "../errors.ts";

type Issue = z.core.$ZodIssue;

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = input;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null || !Object.hasOwn(cur, key))
      return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

const dotted = (path: readonly PropertyKey[]): string =>
  path.map((p) => String(p)).join(".");

const LENGTH_ORIGINS = new Set(["string", "array", "set"]);

function mapIssue(
  issue: Issue,
  where: FieldLocation,
  input: unknown,
): FieldError[] {
  const field = dotted(issue.path);
  const at = (i: FieldIssue): FieldError[] => [fieldError(where, field, i)];
  switch (issue.code) {
    case "unrecognized_keys":
      return issue.keys.map((k) =>
        fieldError(where, field === "" ? k : `${field}.${k}`, "unknown_field"),
      );
    case "invalid_type":
      return at(
        valueAt(input, issue.path) === undefined ? "required" : "invalid_type",
      );
    case "too_small":
      return at(LENGTH_ORIGINS.has(issue.origin) ? "too_short" : "too_small");
    case "too_big":
      return at(LENGTH_ORIGINS.has(issue.origin) ? "too_long" : "too_big");
    case "invalid_format":
      return at("invalid_format");
    case "custom": {
      const p = issue.params as { issue?: FieldIssue } | undefined;
      return at(p?.issue ?? "invalid_value");
    }
    case "invalid_union":
      // A union whose discriminator matched no branch (MfaProof.method).
      return valueAt(input, issue.path) === undefined
        ? at("required")
        : at("invalid_value");
    default:
      return at("invalid_value");
  }
}

export function zodToFieldErrors(
  error: z.ZodError,
  where: FieldLocation,
  input: unknown,
): FieldError[] {
  return error.issues.flatMap((i) => mapIssue(i, where, input)).slice(0, 50);
}

/** Parses or throws 400 VALIDATION_FAILED with field details. */
export function parseOrThrow<T>(
  schema: z.ZodType<T>,
  input: unknown,
  where: FieldLocation,
): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  throw validationFailed(zodToFieldErrors(r.error, where, input));
}

// ------------------------------------------------------------ primitives

const custom = (ctx: z.core.$RefinementCtx, issue: FieldIssue): void => {
  ctx.addIssue({ code: "custom", message: issue, params: { issue } });
};

/** Length in Unicode code points (JSON Schema maxLength semantics, Postgres char_length). */
export function codePoints(s: string): number {
  return Array.from(s).length;
}
// Same whitespace set as db is_clean_text (incl. U+200B), so trimmed text
// always passes the database CHECK.
const EDGE_SPACE = /^[\s\u200b]+|[\s\u200b]+$/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Trimmed, NFC, no control characters, min..max code points (data-model.md "Text"). */
export function text(min: number, max: number) {
  return z.string().transform((raw, ctx) => {
    const v = raw.normalize("NFC").replace(EDGE_SPACE, "");
    if (CONTROL.test(v)) {
      custom(ctx, "invalid_value");
      return z.NEVER;
    }
    const n = codePoints(v);
    if (n < min) custom(ctx, "too_short");
    else if (n > max) custom(ctx, "too_long");
    return v;
  });
}

/** Payee / memo: trimmed; empty becomes null; at most max code points. */
export function optionalText(max: number) {
  return z
    .union([z.null(), text(0, max)])
    .transform((v) => (v === "" ? null : v));
}

/** Passwords are never trimmed or normalized; length counts code points. */
export function password(min: number, max: number) {
  return z.string().superRefine((v, ctx) => {
    const n = codePoints(v);
    if (n < min) custom(ctx, "too_short");
    else if (n > max) custom(ctx, "too_long");
  });
}

export const uuid = z.uuid().transform((v) => v.toLowerCase());
export const email = z
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
export const token = z
  .string()
  .min(43)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
export const version = z.int().min(1).max(2_147_483_647);
export const cents = z.int().min(0).max(100_000_000);
export const positiveCents = z.int().min(1).max(100_000_000);

export const calendarDate = z.string().superRefine((v, ctx) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !isCalendarDate(v))
    custom(ctx, "invalid_format");
});

/** `YYYY-MM`, restricted to the years the database accepts (2000-2099). */
export const month = z.string().superRefine((v, ctx) => {
  if (!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(v)) {
    custom(ctx, "invalid_format");
    return;
  }
  const y = Number(v.slice(0, 4));
  if (y < 2000) custom(ctx, "too_small");
  else if (y > 2099) custom(ctx, "too_big");
});

export const timezone = z.string().superRefine((v, ctx) => {
  if (v.length < 1 || v.length > 64) {
    custom(ctx, v.length < 1 ? "too_short" : "too_long");
    return;
  }
  // The database CHECK bounds the shape; Intl decides whether the zone exists.
  if (!/^[A-Za-z0-9_+/-]{1,64}$/.test(v) || !isValidTimeZone(v))
    custom(ctx, "invalid_value");
});

export const cursor = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Query integers arrive as strings: digits only. */
export function queryInt(min: number, max: number) {
  return z
    .string()
    .regex(/^[0-9]{1,10}$/)
    .transform(Number)
    .pipe(z.int().min(min).max(max));
}

export const queryBool = z
  .enum(["true", "false"])
  .transform((v) => v === "true");

/** Body for operations without a request body: absent, or an empty object. */
export const noBody = z.unknown().superRefine((v, ctx) => {
  if (v === undefined) return;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    custom(ctx, "invalid_type");
    return;
  }
  for (const key of Object.keys(v))
    ctx.addIssue({ code: "custom", message: "unknown_field", params: { issue: "unknown_field" }, path: [key] });
});

/** Query for operations without query parameters. */
export const noQuery = z.strictObject({});
