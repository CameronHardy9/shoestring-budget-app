// Where the stack is. `make e2e` (.github/scripts/e2e.sh) exports BASE_URL,
// APP_ORIGIN and the three database URLs; the local helper
// (tests/scripts/stack.sh up) writes the same names to tests/.env.stack, which
// is read only when APP_ORIGIN is not already set.
//
// API suites talk to the backend directly (API_URL), not through the Vite dev
// proxy at BASE_URL: Vite answers OPTIONS itself (CORS preflight) and adds CORS
// headers, so going through it would test Vite instead of the API. The Host
// header is still set to APP_ORIGIN's host, exactly what the browser sends.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const stackFile = fileURLToPath(new URL("../.env.stack", import.meta.url));
function loadStackFile(): Record<string, string> {
  const file = stackFile;
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!m?.[1]) continue;
    out[m[1]] = (m[2] ?? "").replace(/^'(.*)'$/, "$1");
  }
  return out;
}

// Vitest itself sets process.env.BASE_URL to Vite's base ("/"), so only an
// absolute URL counts, and APP_ORIGIN decides whether the stack file is needed.
const fromProcess = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k, v]) => k !== "BASE_URL" || /^https?:\/\//.test(v ?? ""),
  ),
);
const source: Record<string, string | undefined> = process.env.APP_ORIGIN
  ? fromProcess
  : { ...loadStackFile(), ...fromProcess };

function required(name: string): string {
  const v = source[name];
  if (!v)
    throw new Error(
      `${name} is not set. Run the suites through \`make e2e\`, or start a local stack first: bash tests/scripts/stack.sh up`,
    );
  return v;
}

function apiUrl(): string {
  if (source.API_URL) return source.API_URL.replace(/\/$/, "");
  // make e2e exports the backend's host port (.github/scripts/e2e.sh).
  if (source.BACKEND_PORT) return `http://127.0.0.1:${source.BACKEND_PORT}`;
  return (source.BASE_URL ?? required("APP_ORIGIN")).replace(/\/$/, "");
}

export const env = Object.freeze({
  /** Exact origin the browser uses; the backend checks Host and Origin against it. */
  appOrigin: required("APP_ORIGIN").replace(/\/$/, ""),
  /** The frontend (Vite dev server) for browser suites. */
  baseUrl: (source.BASE_URL ?? required("APP_ORIGIN")).replace(/\/$/, ""),
  /** The backend itself. */
  apiUrl: apiUrl(),
  /** `app` role: the DAL used by the factories. */
  databaseUrl: required("DATABASE_URL"),
  /** Superuser, local/test only: seeding states the API refuses to build (auth.md §9 test 2). */
  databaseAdminUrl: required("DATABASE_ADMIN_URL"),
});

export const appHost = new URL(env.appOrigin).host;
