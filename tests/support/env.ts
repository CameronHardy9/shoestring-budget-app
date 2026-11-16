// Where the stack is. `make e2e` (.github/scripts/e2e.sh) exports BASE_URL,
// APP_ORIGIN and the three database URLs; the local helper
// (tests/scripts/stack.sh up) writes the same names to tests/.env.stack, which
// is used (whole) only when APP_ORIGIN is not exported (env-guards.ts). Every
// address must be loopback (F-56). The database URLs, checked to be local, are
// in db-env.ts, so this module loads no database packages.
//
// API suites talk to the backend directly (API_URL), not through the Vite dev
// proxy at BASE_URL: Vite answers OPTIONS itself (CORS preflight) and adds CORS
// headers, so going through it would test Vite instead of the API. The Host
// header is still set to APP_ORIGIN's host, exactly what the browser sends.
import { loopbackOrigin, stackSource, StackEnvError } from "./env-guards.ts";

// Throws StackEnvError when a stack variable is exported in the shell with a
// value other than tests/.env.stack's (F-56; env-guards.ts).
const source = stackSource();

function required(name: string): string {
  const v = source[name];
  if (!v)
    throw new StackEnvError(
      `${name} is not set. Run the suites through \`make e2e\`, or start a local stack first: bash tests/scripts/stack.sh up`,
    );
  return v;
}

function apiUrl(): string {
  if (source.API_URL) return loopbackOrigin("API_URL", source.API_URL);
  // make e2e exports the backend's host port (.github/scripts/e2e.sh).
  if (source.BACKEND_PORT)
    return loopbackOrigin(
      "BACKEND_PORT",
      `http://127.0.0.1:${source.BACKEND_PORT}`,
    );
  return baseUrl;
}

// Every address must be loopback (F-56): the suites reset the stack and use
// test-only hooks, so they never talk to anything but a local stack.
const appOrigin = loopbackOrigin("APP_ORIGIN", required("APP_ORIGIN"));
const baseUrl = source.BASE_URL
  ? loopbackOrigin("BASE_URL", source.BASE_URL)
  : appOrigin;

export const env = Object.freeze({
  /** Exact origin the browser uses; the backend checks Host and Origin against it. */
  appOrigin,
  /** The frontend (Vite dev server) for browser suites. */
  baseUrl,
  /** The backend itself. */
  apiUrl: apiUrl(),
});

export const appHost = new URL(env.appOrigin).host;

/**
 * True when no backend address is known and API calls go through the Vite dev
 * proxy (the visual suite in the Playwright container gets only BASE_URL). Vite
 * then adds its own CORS headers, which the contract oracle must not blame on
 * the backend.
 */
export const viaDevProxy = env.apiUrl === env.baseUrl;
