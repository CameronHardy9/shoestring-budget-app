// What may leave the browser for Sentry (ARCHITECTURE "Error tracking", F-06,
// F-07). An allowlist, not a denylist: every event is rebuilt from scratch with
// only these fields, so anything the SDK or a future integration adds is
// dropped unless it is listed here.
//
//   kept: error type names and stack frames (own hashed chunk URL without
//         ?/# or "<external>", identifier-only function name, line, column;
//         frames whose text came from the message or the V8 header are
//         dropped: F-59, F-63; no frames at all when a V8 stack's header
//         isn't the error's current one, or the linked-error walk hits its
//         cap: F-62, F-63),
//         mechanism, level, release, environment, timestamp, event ID, SDK
//         name, the route TEMPLATE (/budgets/:budgetId), the opaque user ID,
//         the failing API response's requestId, the browser (User-Agent), and
//         breadcrumbs reduced to fetch (method, path, status) and navigation
//         (route templates).
//         Error messages only when the whole message matches a reviewed
//         SAFE_MESSAGES pattern (below); any other message becomes REDACTED.
//   never: free-text error messages (they can quote API data: JSON.parse and
//          React errors include input text), URLs with query or fragment, page
//          paths, emails, names, amounts, payees, memos, request or response
//          bodies, headers other than User-Agent, extra, contexts, other tags.
//
// Pure functions with type-only Sentry imports, so they are tested without
// initialising the SDK (observability/scrub.test.ts uses only its stack
// parser) and the main bundle never loads it.
import type { Breadcrumb, ErrorEvent, EventHint } from "@sentry/browser";
import { ERROR_COPY } from "../api/messages.ts";

/** Maps a pathname to its route template, e.g. "/budgets/:budgetId". */
export type RouteOf = (pathname: string) => string;

export interface ScrubContext {
  routeOf: RouteOf;
  /** The page's pathname when the event was captured. */
  pathname: string;
  /** Opaque user ID while signed in. */
  userId: string | null;
  userAgent: string;
  /** The page's own origin (location.origin), for own-asset messages. */
  origin: string;
  /**
   * Whether this engine's error.stack starts with the "Name: message" header
   * (V8). Defaults to a one-time probe; tests set it to model other engines.
   */
  stackHeader?: boolean;
}

/** Cuts a URL at the first "?" or "#" (F-06: tokens travel in fragments). */
export function stripUrl(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** The path of a URL (absolute or relative), without origin, query or fragment. */
export function pathOf(url: string): string {
  const bare = stripUrl(url);
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(bare);
  if (match) return match[1] ?? "/";
  return bare.startsWith("/") ? bare : "/";
}

const IDENTIFIER = /^[A-Za-z_$][\w$.]{0,63}$/;
/**
 * Stack-frame function names as browsers print them, and nothing with free
 * text (F-59): an optional "new "/"async " prefix, then identifier characters
 * plus "." (Object.save), "<" ">" (Object.<anonymous>, Firefox's "fn/<") and
 * "/" (Firefox nesting), then Chrome's optional " [as name]". No "@", no
 * other spaces. Anything else (incl. Sentry's "?") becomes ANONYMOUS.
 */
const FUNCTION_NAME =
  /^(?:new |async )?[\w$.<>/]{1,128}(?: \[as [\w$]{1,64}\])?$/;
export const ANONYMOUS = "<anonymous>";
/** A frame's file that is not one of this app's own chunks (F-59). */
export const EXTERNAL = "<external>";
/** Fixed browser pseudo-files: no data, worth keeping (Array.map in native). */
const PSEUDO_FILES: ReadonlySet<string> = new Set([
  "<anonymous>",
  "native",
  "[native code]",
]);
/**
 * A known-safe error message (owner ruling, docs/mvp-planning/10 round 8).
 * Rules, enforced by patternProblems() and its test:
 * - anchored ^…$, no flags except "u" (no m: line anchors; no g/y: stateful);
 * - no free text: no ".", no negated class "[^…]", no \S \W \D, no unbounded
 *   "*", "+" or "{n,}", no top-level "|";
 * - every variable part bounded to tokens that cannot carry user or API data
 *   (digits, the app's own hashed asset path), with the reason in a comment.
 * Adding or widening an entry needs security-reviewer sign-off.
 */
export interface SafeMessage {
  re: RegExp;
  /** Extra check on the match; false drops the message. */
  check?: (match: RegExpExecArray, ctx: ScrubContext) => boolean;
}

/** An own-origin, content-hashed JS chunk: assets/<chunk name>-<8 hex>.js. */
const OWN_ASSET =
  "(https?://[a-z0-9.-]{1,253}(?::\\d{1,5})?)/assets/[A-Za-z0-9_-]{1,64}-[0-9a-f]{8}\\.js";
const ownOrigin = (match: RegExpExecArray, ctx: ScrubContext) =>
  match[1] === ctx.origin;
const OWN_ASSET_URL = new RegExp(`^${OWN_ASSET}$`);

/**
 * A stack frame's file as it may be sent (F-59): this origin's own hashed
 * chunk (cut at ?/#), a fixed pseudo-file, or EXTERNAL. Never free text.
 */
export function safeFrameFile(filename: unknown, ctx: ScrubContext): string {
  if (typeof filename !== "string") return EXTERNAL;
  if (PSEUDO_FILES.has(filename)) return filename;
  const bare = stripUrl(filename);
  const match = OWN_ASSET_URL.exec(bare);
  return match && ownOrigin(match, ctx) ? bare : EXTERNAL;
}

/** A stack frame's function name as it may be sent (F-59). */
export function safeFrameFunction(name: unknown): string {
  return typeof name === "string" && FUNCTION_NAME.test(name)
    ? name
    : ANONYMOUS;
}

/**
 * Whether a parsed frame came from a message line rather than the real
 * stack (F-59). V8's error.stack starts with the whole header and Sentry
 * skips only lines containing "Error: ", so a frame-shaped later message line
 * ("    at x (y:1:2)"), and on V8 also a header line without "Error: " (F-63),
 * becomes a frame. Such a frame's file or "at fn " / "fn@" text is in one of
 * `tails`. Over-matching only drops a frame.
 */
export function fromMessage(
  frame: { filename?: unknown; function?: unknown },
  tails: readonly string[],
): boolean {
  if (tails.length === 0) return false;
  const { filename, function: fn } = frame;
  const needles: string[] = [];
  if (typeof filename === "string" && filename !== "") needles.push(filename);
  if (typeof fn === "string" && fn !== "" && fn !== "?")
    needles.push(`at ${fn} `, `at ${fn}(`, `${fn}@`);
  return needles.some((n) => tails.some((t) => t.includes(n)));
}

/**
 * A text as @sentry/core's createStackParser sees it, line by line, just
 * before parsing (F-62 a): each line cut to 1024 characters, then its first
 * "(error: X)" rewritten to "X" (the SDK's own regex). A message line can use
 * this to yield a frame whose function or file is not verbatim in the message,
 * e.g. "    at Pharm(error: acy (/assets/fo)o:4500:2" → Pharmacy, /assets/foo.
 */
export function asStackParserSees(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      (line.length > 1024 ? line.slice(0, 1024) : line).replace(
        /\(error: (.*)\)/,
        "$1",
      ),
    )
    .join("\n");
}

/**
 * Each message's text after its first line (only multi-line messages), both
 * verbatim and as the SDK's stack parser sees it (F-62 a).
 */
function messageTails(messages: readonly unknown[]): string[] {
  const tails: string[] = [];
  for (const m of messages) {
    if (typeof m !== "string") continue;
    const nl = m.indexOf("\n");
    if (nl === -1) continue;
    const tail = m.slice(nl + 1);
    tails.push(tail);
    const parsed = asStackParserSees(tail);
    if (parsed !== tail) tails.push(parsed);
  }
  return tails;
}

/** The header V8 puts on error.stack (ErrorUtils::ToString). */
export function v8StackHeader(name: string, message: string): string {
  if (name === "") return message;
  if (message === "") return name;
  return `${name}: ${message}`;
}

/**
 * The lines of a V8 stack header that the SDK's stack parser does NOT skip
 * (F-63), as it sees them: it skips only lines containing "Error: ", so the
 * first line of a header whose name doesn't end in "Error" (ReauthCancelled)
 * and every line of a multi-line name are parsed like any stack line.
 */
export function parsedHeaderLines(header: string): string[] {
  return asStackParserSees(header)
    .split("\n")
    .filter((line) => !line.includes("Error: "));
}

let engineHeader: boolean | undefined;
/** Whether this engine starts error.stack with the header (V8: yes; Firefox, Safari: no). */
function engineStackHeader(): boolean {
  if (engineHeader === undefined) {
    const probe = new Error("stack header probe").stack;
    engineHeader =
      typeof probe === "string" &&
      probe.startsWith("Error: stack header probe");
  }
  return engineHeader;
}

/** The text the SDK parses frames from (`ex.stacktrace || ex.stack || ""`). */
function stackText(error: object): unknown {
  const { stacktrace, stack } = error as {
    stacktrace?: unknown;
    stack?: unknown;
  };
  return stacktrace || stack || "";
}

/**
 * Checks that an error's stack starts with exactly its CURRENT header
 * (F-62 b) and returns the header lines the SDK parses from it (F-63), or
 * null if the header is not current. V8 fixes the header when `.stack` is
 * first read; a message (or name) changed afterwards leaves the old one, whose
 * later lines the SDK would parse as frames, while the message tails come from
 * the new one. An error with no stack text passes with no lines (the SDK
 * parsed no frames from it). Name and message are read once, so the lines
 * are those of the header that was checked.
 */
function currentHeaderLines(error: object): string[] | null {
  const text = stackText(error);
  if (text === "") return [];
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (
    typeof text !== "string" ||
    typeof name !== "string" ||
    typeof message !== "string"
  )
    return null;
  const header = v8StackHeader(name, message);
  return text === header || text.startsWith(`${header}\n`)
    ? parsedHeaderLines(header)
    : null;
}

const MAX_LINKED = 32;
/**
 * The thrown value and every error the SDK's linkedErrors integration can
 * reach from it (cause, AggregateError.errors, SuppressedError.error and
 * .suppressed), depth-first, cycles bounded. A superset of what the SDK
 * follows (it follows only values passing its isError, which functions can):
 * checking extra objects can only drop frames. Null when the walk reaches
 * MAX_LINKED values (F-63): stopping there could leave unchecked an error the
 * SDK still reports, e.g. an errors[] child after a long non-Error cause chain.
 */
function reachableErrors(original: object): object[] | null {
  const seen = new Set<object>();
  /** False once the walk reaches the cap. */
  const visit = (value: unknown): boolean => {
    if (typeof value !== "object" && typeof value !== "function") return true;
    if (value === null || seen.has(value)) return true;
    if (seen.size >= MAX_LINKED) return false;
    seen.add(value);
    const e = value as {
      cause?: unknown;
      errors?: unknown;
      error?: unknown;
      suppressed?: unknown;
    };
    if (!visit(e.cause)) return false;
    if (Array.isArray(e.errors))
      for (const child of e.errors) if (!visit(child)) return false;
    return visit(e.error) && visit(e.suppressed);
  };
  return visit(original) ? [...seen] : null;
}

/** The outcome of checking where an event's frames came from. */
interface StackCheck {
  /** Whether frames may be sent at all (F-62 b). */
  trusted: boolean;
  /** Header lines the SDK parsed as stack lines, for fromMessage (F-63). */
  headerLines: string[];
}
const UNTRUSTED: StackCheck = { trusted: false, headerLines: [] };

/**
 * Whether the event's stack frames may be sent at all (F-62 b, fail closed).
 * On an engine whose stacks hold the message (V8), every frame must come from
 * a stack whose header is the error's current one: the thrown value must be an
 * object with its own stack text (else the frames came from something we
 * can't check, such as an ErrorEvent's .error), every linked error must pass
 * too, the walk over linked errors may not hit its cap (F-63), and there may
 * be no more exception values than errors we checked. Firefox and Safari
 * stacks never hold the message, so there is nothing to check. Any getter
 * that throws drops the frames.
 */
export function framesTrusted(
  original: unknown,
  valueCount: number,
  headerEngine: boolean,
): boolean {
  return checkStacks(original, valueCount, headerEngine).trusted;
}

/**
 * framesTrusted, plus every checked error's parsed header lines (F-63). On
 * V8 those lines are frame text the message tails don't hold: the header's
 * first line and the lines of a multi-line name.
 */
function checkStacks(
  original: unknown,
  valueCount: number,
  headerEngine: boolean,
): StackCheck {
  if (!headerEngine) return { trusted: true, headerLines: [] };
  if (typeof original !== "object" || original === null) return UNTRUSTED;
  try {
    const errors = reachableErrors(original);
    if (errors === null || valueCount > errors.length) return UNTRUSTED;
    if (stackText(original) === "") return UNTRUSTED;
    const headerLines: string[] = [];
    for (const error of errors) {
      const lines = currentHeaderLines(error);
      if (lines === null) return UNTRUSTED;
      headerLines.push(...lines);
    }
    return { trusted: true, headerLines };
  } catch {
    return UNTRUSTED;
  }
}

export const SAFE_MESSAGES: readonly SafeMessage[] = [
  // UnexpectedResponseError (api/errors.ts): built from the status code only.
  { re: /^Unexpected response \(HTTP \d{3}\)$/ },
  // App errors whose message is a fixed string with no interpolation:
  // NetworkError (api/errors.ts), SignOutError and the provider guards
  // (app/auth.tsx), ReauthCancelled (app/reauth.tsx), useToast
  // (app/toast.tsx), useCurrentBudget (BudgetLayout.tsx), the money guards
  // (lib/money.ts, lib/splits.ts; they never quote the amount), the #root
  // guard (main.tsx) and report.ts's "Script error" stand-in (also the
  // browser's own text for a cross-origin script error).
  {
    re: /^(?:Network request failed|Sign-out failed|Re-authentication cancelled|useAuth outside AuthProvider|useMe needs a signed-in user|useReauth outside ReauthProvider|useToast outside ToastProvider|useCurrentBudget outside BudgetLayout|Money amounts must be integer cents\.|missing #root|Script error\.?)$/,
  },
  // React production errors: fixed text plus the error number. React puts
  // values in the decoder URL's ?args[]=…; stripReactArgs() removes them
  // before matching, and \1 pins the URL to the same number.
  {
    re: /^Minified React error #(\d{1,4}); visit https:\/\/react\.dev\/errors\/\1 for the full message or use the non-minified dev environment for full errors and additional helpful warnings\.$/,
  },
  // A lazy chunk failed to load (deploy skew, offline). Chrome and Firefox
  // name the module URL, which must be one of this app's own hashed chunks on
  // this origin (path only: no query or fragment can match); Safari names
  // nothing.
  {
    re: new RegExp(
      `^(?:Failed to fetch|error loading) dynamically imported module: ${OWN_ASSET}$`,
    ),
    check: ownOrigin,
  },
  { re: /^Importing a module script failed\.$/ },
  // The browsers' own fetch() network TypeErrors (Chrome, Safari, Firefox):
  // fixed strings, no URL.
  {
    re: /^(?:Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.)$/,
  },
  // Benign layout warnings (Chrome, older Chrome): fixed strings.
  {
    re: /^ResizeObserver loop (?:completed with undelivered notifications\.|limit exceeded)$/,
  },
];

/**
 * Why `re` breaks the SafeMessage rules, or [] if it doesn't. A lexical check
 * of the pattern source, deliberately strict: when in doubt it complains.
 */
export function patternProblems(re: RegExp): string[] {
  const problems: string[] = [];
  const src = re.source;
  if (!/^u?$/.test(re.flags)) problems.push(`flags "${re.flags}"`);
  if (!src.startsWith("^")) problems.push("not anchored at the start");
  let endAnchored = false;
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const next = src[i + 1] ?? "";
      if ("SWD".includes(next)) problems.push(`catch-all \\${next}`);
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      if (src[i + 1] === "^") problems.push("negated class [^…]");
    } else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "|" && depth === 0) problems.push("top-level |");
    else if (c === ".") problems.push("wildcard .");
    else if (c === "*" || c === "+") problems.push(`unbounded ${c}`);
    else if (c === "{" && /^\{\d*,\}/.test(src.slice(i)))
      problems.push("unbounded {n,}");
    else if (c === "^" && i > 0) problems.push("^ after the start");
    else if (c === "$") {
      if (i === src.length - 1) endAnchored = true;
      else problems.push("$ before the end");
    }
  }
  if (!endAnchored) problems.push("not anchored at the end");
  return problems;
}

/** Removes the values React puts in its error-decoder URL (?args[]=…). */
export function stripReactArgs(message: string): string {
  // encodeURIComponent leaves no whitespace, so the args end at the next space.
  return message.replace(
    /(https:\/\/react\.dev\/errors\/\d{1,4})[?#]\S*/g,
    "$1",
  );
}

export const REDACTED = "[message removed]";

/**
 * The message if it is a contract error code (ApiError's message) or wholly
 * matches a SAFE_MESSAGES pattern; otherwise REDACTED.
 */
export function safeMessage(
  value: unknown,
  ctx: ScrubContext,
  patterns: readonly SafeMessage[] = SAFE_MESSAGES,
): string {
  if (typeof value !== "string") return REDACTED;
  // ApiError's message is its contract code; only codes errors.md defines.
  if (Object.hasOwn(ERROR_COPY, value)) return value;
  const message = stripReactArgs(value);
  for (const { re, check } of patterns) {
    const match = re.exec(message);
    // Whole-string match, even if a pattern's anchoring were ever broken.
    if (
      match?.index === 0 &&
      match[0].length === message.length &&
      (check?.(match, ctx) ?? true)
    )
      return message;
  }
  return REDACTED;
}

function safeType(type: unknown): string {
  return typeof type === "string" && IDENTIFIER.test(type) ? type : "Error";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The requestId of a failed API response (ApiError, UnexpectedResponseError). */
export function requestIdOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const id = (error as { requestId?: unknown }).requestId;
  // The contract RequestId pattern; anything else is not sent.
  return typeof id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : null;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Reduces a breadcrumb to what may be sent, or null to drop it. Only fetch/xhr
 * (method, path, status) and navigation (route templates) survive.
 */
export function scrubBreadcrumb(
  crumb: Breadcrumb,
  routeOf: RouteOf,
): Breadcrumb | null {
  const data = (crumb.data ?? {}) as Record<string, unknown>;
  const base = {
    category: crumb.category ?? "",
    ...(crumb.type ? { type: crumb.type } : {}),
    ...(crumb.level ? { level: crumb.level } : {}),
    ...(crumb.timestamp !== undefined ? { timestamp: crumb.timestamp } : {}),
  };
  if (crumb.category === "fetch" || crumb.category === "xhr") {
    const method =
      typeof data.method === "string" && /^[A-Z]{3,7}$/.test(data.method)
        ? data.method
        : undefined;
    const status = num(data.status_code);
    return {
      ...base,
      data: {
        ...(method ? { method } : {}),
        url: typeof data.url === "string" ? pathOf(data.url) : "/",
        ...(status !== undefined ? { status_code: status } : {}),
      },
    };
  }
  if (crumb.category === "navigation") {
    const route = (v: unknown) =>
      typeof v === "string" ? routeOf(pathOf(v)) : undefined;
    const from = route(data.from);
    const to = route(data.to);
    return {
      ...base,
      data: { ...(from ? { from } : {}), ...(to ? { to } : {}) },
    };
  }
  return null;
}

/** Rebuilds an event from the allowlist above (Sentry `beforeSend`). */
export function scrubEvent(
  event: ErrorEvent,
  hint: EventHint,
  ctx: ScrubContext,
): ErrorEvent {
  const route = ctx.routeOf(pathOf(ctx.pathname));
  const requestId = requestIdOf(hint.originalException);
  const original = hint.originalException;
  // No frames unless every stack they came from has its current header (F-62).
  const { trusted: keepFrames, headerLines } = checkStacks(
    original,
    event.exception?.values?.length ?? 0,
    ctx.stackHeader ?? engineStackHeader(),
  );
  // Every message frames may have been parsed from: the values (possibly
  // truncated by the SDK) and the thrown error's own (F-59), plus on V8 each
  // checked header's lines the parser doesn't skip (F-63).
  const tails = [
    ...messageTails([
      ...(event.exception?.values ?? []).map((v) => v.value),
      typeof original === "object" && original !== null
        ? (original as { message?: unknown }).message
        : undefined,
    ]),
    ...headerLines,
  ];
  const values = (event.exception?.values ?? []).map((v) => ({
    type: safeType(v.type),
    value: safeMessage(v.value, ctx),
    ...(v.mechanism
      ? {
          mechanism: {
            type: safeType(v.mechanism.type),
            ...(typeof v.mechanism.handled === "boolean"
              ? { handled: v.mechanism.handled }
              : {}),
          },
        }
      : {}),
    ...(keepFrames && v.stacktrace?.frames
      ? {
          stacktrace: {
            frames: v.stacktrace.frames
              .filter((f) => !fromMessage(f, tails))
              .map((f) => ({
                filename: safeFrameFile(f.filename, ctx),
                function: safeFrameFunction(f.function),
                ...(num(f.lineno) !== undefined ? { lineno: f.lineno } : {}),
                ...(num(f.colno) !== undefined ? { colno: f.colno } : {}),
                ...(typeof f.in_app === "boolean" ? { in_app: f.in_app } : {}),
              })),
          },
        }
      : {}),
  }));
  const breadcrumbs = (event.breadcrumbs ?? [])
    .map((b) => scrubBreadcrumb(b, ctx.routeOf))
    .filter((b): b is Breadcrumb => b !== null);
  return {
    type: undefined,
    ...(event.event_id ? { event_id: event.event_id } : {}),
    ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
    ...(event.platform ? { platform: event.platform } : {}),
    ...(event.level ? { level: event.level } : {}),
    ...(event.release ? { release: event.release } : {}),
    ...(event.environment ? { environment: event.environment } : {}),
    ...(event.sdk?.name && event.sdk.version
      ? { sdk: { name: event.sdk.name, version: event.sdk.version } }
      : {}),
    ...(values.length > 0 ? { exception: { values } } : {}),
    transaction: route,
    tags: { route, ...(requestId ? { requestId } : {}) },
    ...(ctx.userId && UUID.test(ctx.userId)
      ? { user: { id: ctx.userId } }
      : {}),
    request: { headers: { "User-Agent": ctx.userAgent } },
    ...(breadcrumbs.length > 0 ? { breadcrumbs } : {}),
  };
}
