// Error tracking with Sentry (ARCHITECTURE "Error tracking (F-06, F-07)",
// errors.md "Logging rules", observability/README.md A2, A3, A6).
//
// Privacy by construction:
// - The raw error never reaches the SDK. captureError serializes it through the
//   F-07 allowlist (logging.ts serializeError) and builds the event from that:
//   name, SQLSTATE code, constraint, table, column, and stack frames only.
// - beforeSend rebuilds EVERY event (also those from the uncaught-exception
//   integration) from an allowlist: level, release, environment, fingerprint,
//   the tags requestId, userId and route, user.id, exception type, an
//   allowlisted value and frame locations, and our own fixed alert messages.
//   Request data, headers, cookies, bodies, query strings, contexts, extra,
//   breadcrumbs and server name are never copied.
// - No default integrations, no breadcrumbs, no tracing, every v11
//   `dataCollection` category off (v11 replaced `sendDefaultPii`).
// Without SENTRY_DSN this is a no-op and @sentry/node is never loaded.
import type {
  ErrorEvent,
  Event,
  Exception,
  NodeOptions,
  StackFrame,
} from "@sentry/node";
import type { SafeError } from "../logging.ts";
import { serializeError } from "../logging.ts";

export interface ErrorContext {
  requestId: string;
  /** Opaque user ID (UUID) or null when anonymous. */
  userId: string | null;
  /** Route template (e.g. /api/budgets/:budgetId), never the raw URL. */
  route: string | null;
}

/** The only messages an event may carry (A6). Fixed text, no values. */
export const ALERTS = {
  emailQuotaWarning: {
    level: "warning",
    message: "email_quota_threshold: 80% of EMAIL_DAILY_QUOTA used today",
    fingerprint: ["email-quota-threshold"],
  },
  emailQuotaReached: {
    level: "error",
    message: "email_quota_threshold: 100% of EMAIL_DAILY_QUOTA used today",
    fingerprint: ["email-quota-threshold"],
  },
} as const;
export type Alert = (typeof ALERTS)[keyof typeof ALERTS];
const ALLOWED_MESSAGES: ReadonlySet<string> = new Set(
  Object.values(ALERTS).map((a) => a.message),
);

/** A3: observability/README.md "Cron monitor" (the SDK upserts these exact values). */
export const PURGE_MONITOR = {
  slug: "purge",
  config: {
    schedule: { type: "crontab", value: "0 8 * * *" },
    timezone: "UTC",
    checkinMargin: 60,
    maxRuntime: 15,
    failureIssueThreshold: 1,
    recoveryThreshold: 1,
  },
} as const;
export type Monitor = typeof PURGE_MONITOR;

export interface CheckIn {
  finish(status: "ok" | "error"): void;
}

export interface ErrorTracker {
  readonly enabled: boolean;
  /** Unexpected (5xx) errors only; contract 4xx never come here. */
  captureError(err: unknown, ctx: ErrorContext): void;
  alert(alert: Alert): void;
  /** Sends `in_progress` now; finish() sends `ok` or `error` with the duration. */
  startCheckIn(monitor: Monitor): CheckIn;
  flush(timeoutMs?: number): Promise<void>;
  /** Flushes and disables the client (end of a job). */
  close(timeoutMs?: number): Promise<void>;
}

export const NO_TRACKING: ErrorTracker = {
  enabled: false,
  captureError: () => {},
  alert: () => {},
  startCheckIn: () => ({ finish: () => {} }),
  flush: () => Promise.resolve(),
  close: () => Promise.resolve(),
};

// ------------------------------------------------------------------ allowlists

const SAFE_TOKEN = /^[A-Za-z0-9_.$:-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ROUTE = /^\/[A-Za-z0-9/:_.*-]{0,200}$/;
const FUNCTION = /^[A-Za-z0-9_.$<>[\] -]{1,200}$/;
const FILENAME = /^[A-Za-z0-9_./:@+-]{1,300}$/;
const SAFE_FIELDS = ["code", "constraint", "table", "column"] as const;
const VALUE = new RegExp(
  `^(?:${SAFE_FIELDS.join("|")})=[A-Za-z0-9_.$:-]{1,100}(?: (?:${SAFE_FIELDS.join("|")})=[A-Za-z0-9_.$:-]{1,100}){0,3}$`,
);
/** Exception value when no allowlisted field exists (the message is never sent). */
export const WITHHELD = "details withheld (F-07)";

/** File paths without the machine's directories: app:///<path under cwd>, node_modules/..., or the base name. */
export function safeFilename(raw: string, root: string): string | undefined {
  let f = raw.startsWith("file://") ? raw.slice("file://".length) : raw;
  if (f.startsWith("node:") || f.startsWith("app:///")) {
    // already relative
  } else if (f.includes("/node_modules/"))
    f = f.slice(f.lastIndexOf("/node_modules/") + 1);
  else if (root && f.startsWith(`${root}/`))
    f = `app:///${f.slice(root.length + 1)}`;
  else if (f.startsWith("/")) f = f.slice(f.lastIndexOf("/") + 1);
  return FILENAME.test(f) ? f : undefined;
}

const FRAME_LINE = /^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;

/** V8 frame lines (from SafeError.frames) -> Sentry frames, oldest call first. */
export function framesFrom(
  lines: readonly string[],
  root: string,
): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of lines) {
    const m = FRAME_LINE.exec(line);
    const filename = m?.[2] === undefined ? undefined : safeFilename(m[2], root);
    if (!m || !filename) continue;
    frames.push(
      cleanFrame({
        filename,
        function: m[1],
        lineno: Number(m[3]),
        colno: Number(m[4]),
        in_app:
          !filename.startsWith("node_modules/") &&
          !filename.startsWith("node:"),
      }),
    );
  }
  return frames.reverse();
}

function cleanFrame(f: StackFrame): StackFrame {
  const out: StackFrame = {};
  if (typeof f.filename === "string" && FILENAME.test(f.filename))
    out.filename = f.filename;
  if (typeof f.function === "string" && FUNCTION.test(f.function))
    out.function = f.function;
  if (Number.isSafeInteger(f.lineno)) out.lineno = f.lineno;
  if (Number.isSafeInteger(f.colno)) out.colno = f.colno;
  if (typeof f.in_app === "boolean") out.in_app = f.in_app;
  return out;
}

function describe(s: SafeError): string {
  const parts = SAFE_FIELDS.flatMap((k) => {
    const v = s[k];
    return v === undefined ? [] : [`${k}=${v}`];
  });
  return parts.length > 0 ? parts.join(" ") : WITHHELD;
}

function chain(s: SafeError): SafeError[] {
  const out: SafeError[] = [];
  for (let c: SafeError | undefined = s; c && out.length < 3; c = c.cause)
    out.push(c);
  return out;
}

function tags(ctx: ErrorContext): Record<string, string> {
  const t: Record<string, string> = {};
  if (REQUEST_ID.test(ctx.requestId)) t.requestId = ctx.requestId;
  if (ctx.userId && UUID.test(ctx.userId)) t.userId = ctx.userId;
  if (ctx.route && ROUTE.test(ctx.route)) t.route = ctx.route;
  return t;
}

/** The event for an unexpected error, built from the F-07 allowlist only. */
export function errorEvent(
  err: unknown,
  ctx: ErrorContext,
  root: string,
): Event {
  const safe = serializeError(err);
  const values: Exception[] = chain(safe)
    .reverse() // Sentry lists the root cause first
    .map((s) => ({
      type: s.name,
      value: describe(s),
      stacktrace: { frames: framesFrom(s.frames ?? [], root) },
    }));
  const outermost = values.at(-1);
  if (outermost) outermost.mechanism = { type: "generic", handled: true };
  const t = tags(ctx);
  return {
    level: "error",
    exception: { values },
    tags: t,
    ...(t.userId ? { user: { id: t.userId } } : {}),
  };
}

/**
 * beforeSend: rebuilds the event from the allowlist. Applied to every event,
 * including ones the SDK built itself from a raw error (uncaught exceptions).
 */
export function scrubEvent(event: Event, root: string): ErrorEvent {
  const out: Event = {};
  if (typeof event.event_id === "string") out.event_id = event.event_id;
  if (typeof event.timestamp === "number") out.timestamp = event.timestamp;
  if (typeof event.platform === "string") out.platform = event.platform;
  if (event.level) out.level = event.level;
  if (typeof event.release === "string") out.release = event.release;
  if (typeof event.environment === "string")
    out.environment = event.environment;
  if (event.sdk) out.sdk = { name: event.sdk.name, version: event.sdk.version };
  if (Array.isArray(event.fingerprint)) {
    const fp = event.fingerprint.filter((f) => SAFE_TOKEN.test(f));
    if (fp.length > 0) out.fingerprint = fp;
  }
  if (typeof event.message === "string" && ALLOWED_MESSAGES.has(event.message))
    out.message = event.message;
  else if (
    event.logentry?.message !== undefined &&
    ALLOWED_MESSAGES.has(event.logentry.message) &&
    !event.logentry.params?.length
  )
    out.message = event.logentry.message;
  if (event.tags) {
    const t = tags({
      requestId: String(event.tags.requestId ?? ""),
      userId: typeof event.tags.userId === "string" ? event.tags.userId : null,
      route: typeof event.tags.route === "string" ? event.tags.route : null,
    });
    if (Object.keys(t).length > 0) out.tags = t;
  }
  if (typeof event.user?.id === "string" && UUID.test(event.user.id))
    out.user = { id: event.user.id };
  const values = event.exception?.values;
  if (values?.length) {
    out.exception = {
      values: values.slice(-3).map((v) => {
        const e: Exception = {
          type:
            typeof v.type === "string" && SAFE_TOKEN.test(v.type)
              ? v.type
              : "Error",
          value:
            typeof v.value === "string" &&
            (VALUE.test(v.value) || v.value === WITHHELD)
              ? v.value
              : WITHHELD,
        };
        const frames = v.stacktrace?.frames
          ?.map((f) =>
            cleanFrame({
              ...f,
              ...(typeof f.filename === "string"
                ? { filename: safeFilename(f.filename, root) }
                : {}),
            }),
          )
          .slice(-50);
        if (frames?.length) e.stacktrace = { frames };
        if (v.mechanism)
          e.mechanism = {
            type: SAFE_TOKEN.test(v.mechanism.type)
              ? v.mechanism.type
              : "generic",
            ...(typeof v.mechanism.handled === "boolean"
              ? { handled: v.mechanism.handled }
              : {}),
          };
        return e;
      }),
    };
  }
  return out as ErrorEvent;
}

// ------------------------------------------------------------------ the client

export interface TrackerOptions {
  dsn: string | null;
  release: string;
  environment: string;
  /** Server only: report uncaught exceptions, then exit as Node would. */
  captureUncaught?: boolean;
  /** Tests: an in-memory transport instead of HTTPS. */
  transport?: NodeOptions["transport"];
  /** Directory stripped from file paths (default: process.cwd()). */
  root?: string;
}

/** Builds the Sentry options; exported so a test can pin every privacy setting. */
export function sentryOptions(
  o: TrackerOptions & { dsn: string },
  extra: Pick<NodeOptions, "integrations"> = {},
): NodeOptions {
  const root = o.root ?? process.cwd();
  return {
    dsn: o.dsn,
    release: o.release,
    environment: o.environment,
    defaultIntegrations: false,
    integrations: extra.integrations ?? [],
    tracesSampleRate: 0,
    // v11's replacement for sendDefaultPii: false. Every category off.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    includeLocalVariables: false,
    maxBreadcrumbs: 0,
    attachStacktrace: false,
    sendClientReports: false,
    serverName: "shoestring-api",
    enableOpenTelemetrySetup: false,
    enableRuntimeChannelInjection: false,
    // No transactions or spans exist: tracesSampleRate is 0 (v11 streams spans
    // and ignores beforeSendTransaction, so it is not set).
    beforeBreadcrumb: () => null,
    beforeSend: (event) => scrubEvent(event, root),
    ...(o.transport ? { transport: o.transport } : {}),
  };
}

/** Starts Sentry when SENTRY_DSN is set; otherwise returns the no-op tracker. */
export async function initErrorTracker(
  o: TrackerOptions,
): Promise<ErrorTracker> {
  if (!o.dsn) return NO_TRACKING;
  const dsn = o.dsn;
  const root = o.root ?? process.cwd();
  const Sentry = await import("@sentry/node");
  const integrations = o.captureUncaught
    ? [
        Sentry.onUncaughtExceptionIntegration({
          // Node's default prints the raw error; log it through F-07 instead.
          onFatalError: (e: Error) => {
            process.stderr.write(
              `${JSON.stringify({ level: "fatal", msg: "uncaught exception", err: serializeError(e), time: new Date().toISOString() })}\n`,
            );
            process.exit(1);
          },
        }),
      ]
    : [];
  Sentry.init(sentryOptions({ ...o, dsn }, { integrations }));
  return {
    enabled: true,
    captureError: (err, ctx) => {
      Sentry.captureEvent(errorEvent(err, ctx, root));
    },
    alert: (a) => {
      Sentry.captureEvent({
        level: a.level,
        message: a.message,
        fingerprint: [...a.fingerprint],
      });
    },
    startCheckIn: (m) => {
      const started = Date.now();
      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: m.slug, status: "in_progress" },
        { ...m.config, schedule: { ...m.config.schedule } },
      );
      let done = false;
      return {
        finish: (status) => {
          if (done) return;
          done = true;
          Sentry.captureCheckIn({
            checkInId,
            monitorSlug: m.slug,
            status,
            duration: (Date.now() - started) / 1000,
          });
        },
      };
    },
    flush: async (timeoutMs = 2000) => {
      await Sentry.flush(timeoutMs);
    },
    close: async (timeoutMs = 2000) => {
      await Sentry.close(timeoutMs);
    },
  };
}
