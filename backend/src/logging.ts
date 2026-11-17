// Structured JSON logs (pino) with request IDs, and the F-07 allowlist error
// serializer. What may be logged: errors.md "Logging rules" and ARCHITECTURE
// "Request IDs and logging". Never: bodies, query strings, cookies, tokens,
// CSRF tokens, emails, names, IPs, user agents, amounts, payees, memos.
import type { DestinationStream, LoggerOptions } from "pino";
import { pino } from "pino";
import type { Config } from "./config.ts";

export type Logger = pino.Logger;

/** Allowlisted fields of an error. Everything else (message, detail, hint, where, query, params, zod input) is dropped. */
export interface SafeError {
  name: string;
  code?: string;
  constraint?: string;
  table?: string;
  column?: string;
  /** Stack frames only ("at ..." lines after the header): the header carries the message and is dropped. */
  frames?: string[];
  cause?: SafeError;
}

/**
 * A V8 function name (F-59): identifier characters (plus `.`, `#` and
 * `<anonymous>`), an optional `new `/`async ` prefix and `[as alias]` suffix.
 * No free spaces, so a frame holds at most identifier-shaped tokens, never a
 * phrase. Shared with the Sentry event builder.
 */
const IDENT = "[A-Za-z0-9_$#.<>]";
const FN = `(?:new |async )?${IDENT}{1,200}(?: \\[as ${IDENT}{1,100}\\])?`;
export const FUNCTION_NAME = new RegExp(`^${FN}$`);
const LOCATION = "[^()\\n]{1,300}:\\d+:\\d+";
/** `at fn (file:line:col)` or `at file:line:col`, with fn as above. */
const FRAME = new RegExp(`^at (?:${FN} \\(${LOCATION}\\)|${LOCATION})$`);
const SAFE_TOKEN = /^[A-Za-z0-9_.$:-]{1,100}$/;

function safeString(v: unknown): string | undefined {
  return typeof v === "string" && SAFE_TOKEN.test(v) ? v : undefined;
}

/**
 * F-59, F-62: V8's stack starts with a header, `${name}: ${message}` (only one
 * of them when the other is empty; Node's own errors add ` [${code}]` after
 * the name), and the message may span several lines. Only lines after the
 * header are frames, so a message line shaped like a frame
 * (`    at Pharmacy (x.js:1:2)`) never becomes one.
 *
 * V8 fixes the header when `.stack` is first read, so `name` or `message` may
 * have changed since. Frames are kept only when the stack starts with exactly
 * the header built from the current values; otherwise (including a non-string
 * name or message) no frame is kept. Known limit: a message cut at a line
 * boundary after the first read still matches; what can then pass is bounded
 * by FRAME (one identifier-shaped name and two integers per line).
 */
function frameLines(e: Record<string, unknown>, stack: string): string[] {
  const name = e.name === undefined ? "Error" : e.name;
  const message = e.message === undefined ? "" : e.message;
  if (typeof name !== "string" || typeof message !== "string") return [];
  const headers =
    name === "" ? [message] : message === "" ? [name] : [`${name}: ${message}`];
  if (name !== "" && message !== "" && typeof e.code === "string")
    headers.push(`${name} [${e.code}]: ${message}`);
  const header = headers.find((h) => stack.startsWith(`${h}\n`));
  if (header === undefined) return [];
  return stack
    .slice(header.length + 1)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => FRAME.test(l))
    .slice(0, 20);
}

/** F-07: serializes any thrown value through an allowlist. Unit-tested with a DB-error fixture. */
export function serializeError(err: unknown, depth = 0): SafeError {
  if (typeof err !== "object" || err === null) return { name: typeof err };
  const e = err as Record<string, unknown>;
  const out: SafeError = {
    name: safeString(e.name) ?? "Error",
  };
  const code = safeString(e.code);
  if (code) out.code = code;
  for (const key of ["constraint", "table", "column"] as const) {
    const v = safeString(e[key]);
    if (v) out[key] = v;
  }
  if (typeof e.stack === "string") out.frames = frameLines(e, e.stack);
  if (depth < 2 && e.cause !== undefined)
    out.cause = serializeError(e.cause, depth + 1);
  return out;
}

/** Fields that must never be logged even if passed by mistake (defence in depth). */
export const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'req.headers["x-csrf-token"]',
  "headers.cookie",
  "headers.authorization",
  'headers["x-csrf-token"]',
  "body",
  "password",
  "newPassword",
  "token",
  "csrfToken",
  "email",
  "*.email",
  "*.password",
  "*.token",
];

export function loggerOptions(
  config: Pick<Config, "logLevel" | "release">,
): LoggerOptions {
  return {
    level: config.logLevel,
    base: { service: "shoestring-api", release: config.release },
    messageKey: "msg",
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    serializers: { err: serializeError, error: serializeError },
  };
}

export function createLogger(
  config: Pick<Config, "logLevel" | "release">,
  stream?: DestinationStream,
): Logger {
  return stream
    ? pino(loggerOptions(config), stream)
    : pino(loggerOptions(config));
}
