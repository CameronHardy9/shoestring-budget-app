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
  /** Stack frames only ("at ..." lines): the first line carries the message and is dropped. */
  frames?: string[];
  cause?: SafeError;
}

const FRAME = /^at [^\n]{1,300}:\d+:\d+\)?$/;
const SAFE_TOKEN = /^[A-Za-z0-9_.$:-]{1,100}$/;

function safeString(v: unknown): string | undefined {
  return typeof v === "string" && SAFE_TOKEN.test(v) ? v : undefined;
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
  if (typeof e.stack === "string") {
    out.frames = e.stack
      .split("\n")
      .map((l) => l.trim())
      // Only real frames ("at fn (file:line:col)"); the message lines are dropped.
      .filter((l) => FRAME.test(l))
      .slice(0, 20);
  }
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
