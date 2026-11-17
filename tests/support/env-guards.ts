// Guards that keep the suites on a LOCAL stack (F-56). Pure functions plus one
// memoised reader, with no side effects at import and no database packages, so
// env.ts (loaded in the Playwright container too) and the unit test can use
// them. The database half is in db-env.ts.
//
// Where the values come from:
//   - `make e2e` (.github/scripts/e2e.sh) exports APP_ORIGIN and the rest:
//     the process environment is used as is;
//   - otherwise tests/.env.stack (make e2e-up) is used
//     WHOLE. A stack variable that is also exported in the shell with another
//     value is an error, never a silent override: an exported DATABASE_URL
//     meant for something else must not beat the local stack's.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A misconfigured test environment. Messages name the variable, never its value. */
export class StackEnvError extends Error {
  override name = "StackEnvError";
}

/** Every variable that says where the stack is. */
export const STACK_VARS = [
  "APP_ORIGIN",
  "BASE_URL",
  "API_URL",
  "BACKEND_PORT",
  "DATABASE_URL",
  "DATABASE_ADMIN_URL",
  "MIGRATOR_DATABASE_URL",
] as const;

export type Source = Readonly<Record<string, string | undefined>>;

/** KEY=value lines as written by `make e2e-up` (values may be single-quoted). */
export function parseStackFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!m?.[1]) continue;
    out[m[1]] = (m[2] ?? "").replace(/^'(.*)'$/, "$1");
  }
  return out;
}

/**
 * The variables the suites read. `stackFile` is the text of tests/.env.stack,
 * or null when there is none.
 */
export function resolveStackSource(
  processEnv: Source,
  stackFile: string | null,
): Source {
  // Vitest sets BASE_URL to Vite's base ("/"); only an absolute URL counts.
  const fromProcess = Object.fromEntries(
    Object.entries(processEnv).filter(
      ([k, v]) => k !== "BASE_URL" || /^https?:\/\//.test(v ?? ""),
    ),
  );
  if (fromProcess.APP_ORIGIN || stackFile === null) return fromProcess;
  const stack = parseStackFile(stackFile);
  for (const name of STACK_VARS) {
    const exported = fromProcess[name];
    if (exported && exported !== stack[name])
      throw new StackEnvError(
        `${name} is exported in this shell, but APP_ORIGIN is not, so the suites use tests/.env.stack, ` +
          `which ${stack[name] === undefined ? "does not set it" : "sets it to something else"}. ` +
          `Unset ${name} (or export APP_ORIGIN and every stack variable to use the shell's values).`,
      );
  }
  return { ...fromProcess, ...stack };
}

const STACK_FILE = fileURLToPath(new URL("../.env.stack", import.meta.url));
let memo: Source | null = null;

/** The resolved source for this process (read once). */
export function stackSource(): Source {
  memo ??= resolveStackSource(
    process.env,
    existsSync(STACK_FILE) ? readFileSync(STACK_FILE, "utf8") : null,
  );
  return memo;
}

/** The parts of the e2e stack's fake Sentry DSN that the suites derive values from. */
export interface FakeSentryDsn {
  dsn: string;
  /** https://<host>, the origin the browser posts envelopes to. */
  ingestOrigin: string;
  /** The DSN's public key (its user part). */
  publicKey: string;
  /** The numeric project ID (its path). */
  projectId: string;
}

/**
 * E2E_SENTRY_DSN, which `make e2e` and `make e2e-up` export
 * (.github/scripts/lib.sh). It must be shaped like a real DSN but live on a
 * reserved `.test` host (RFC 6761), which never resolves: the production
 * bundle the suites build sends events there, and the browser tests intercept
 * them, so a real DSN here would ship test events (and anything a scrubbing
 * bug lets through) to a real Sentry project.
 */
export function fakeSentryDsn(value: string | undefined): FakeSentryDsn {
  if (!value)
    throw new StackEnvError(
      "E2E_SENTRY_DSN is not set. `make e2e` exports it and `make e2e-up` writes it to tests/.env.stack; start the stack through one of them",
    );
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new StackEnvError("E2E_SENTRY_DSN is not a valid URL");
  }
  const projectId = u.pathname.replace(/^\//, "");
  if (
    u.protocol !== "https:" ||
    !u.hostname.endsWith(".test") ||
    u.port !== "" ||
    !/^[0-9a-f]{32}$/.test(u.username) ||
    u.password !== "" ||
    !/^\d+$/.test(projectId) ||
    u.search !== "" ||
    u.hash !== ""
  )
    throw new StackEnvError(
      "E2E_SENTRY_DSN must be https://<32 hex key>@<host>.test/<project number>: a fake DSN on a reserved .test host, so no test event can reach a real Sentry",
    );
  return {
    dsn: value,
    ingestOrigin: u.origin,
    publicKey: u.username,
    projectId,
  };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `value` as an origin-like URL without a trailing slash, if it is plain http
 * on a loopback host; otherwise a StackEnvError naming `name` (not the value).
 */
export function loopbackOrigin(name: string, value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new StackEnvError(`${name} is not a valid URL`);
  }
  if (
    u.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(u.hostname) ||
    u.username !== "" ||
    u.password !== ""
  )
    throw new StackEnvError(
      `${name} must be an http:// URL on localhost, 127.0.0.1 or [::1]: the suites only run against a local stack`,
    );
  return value.replace(/\/$/, "");
}
