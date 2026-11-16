// The test hooks of docs/contracts/test-hooks.md, and nothing else: reset,
// clock, signup-invites, login, emails. They are not contract operations, so
// their responses skip the OpenAPI oracle (they still use ErrorBody).
import { ApiClient, rawRequest } from "./http.ts";
import type { ApiResponse } from "./http.ts";
import { appHost } from "./env.ts";

/** The instant every test starts at (a Monday mid-month, America/* still on standard time). */
export const DEFAULT_NOW = "2026-11-16T15:00:00.000Z";

async function hook(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; json: unknown }> {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const r = await rawRequest(
    method,
    `/api/_test${path}`,
    {
      host: appHost,
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    payload,
  );
  let json: unknown;
  try {
    json = r.text ? JSON.parse(r.text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: r.status, text: r.text, json };
}

async function expectHook(
  method: string,
  path: string,
  status: number,
  body?: unknown,
): Promise<unknown> {
  const r = await hook(method, path, body);
  if (r.status !== status)
    throw new Error(
      `test hook ${method} /api/_test${path} answered ${r.status} (expected ${status}): ${r.text.slice(0, 300)}. ` +
        "Is the backend the dev entry with TEST_HOOKS=1, EMAIL_TRANSPORT=test and a localhost APP_ORIGIN? (test-hooks.md, ADR-0009)",
    );
  return r.json;
}

// ------------------------------------------------------------ teardown
// Modules with open resources (support/dal.ts) register here, so runners that
// never load them (the visual suite in the Playwright container, which has no
// database packages) need not import them to clean up.
const teardowns: (() => Promise<void>)[] = [];

export function onTeardown(fn: () => Promise<void>): void {
  teardowns.push(fn);
}

export async function runTeardowns(): Promise<void> {
  for (const fn of teardowns.splice(0)) await fn();
}

// ------------------------------------------------------------ the clock
let currentNow = new Date(DEFAULT_NOW);

/** Freezes the server clock at `instant`; the factories' DAL reads now() too. */
export async function setClock(instant: string | Date): Promise<void> {
  const d = new Date(instant);
  await expectHook("POST", "/clock", 204, { now: d.toISOString() });
  currentNow = d;
}

/** Moves both clocks forward. */
export async function advanceClock(ms: number): Promise<void> {
  await setClock(new Date(currentNow.getTime() + ms));
}

export function now(): Date {
  return new Date(currentNow.getTime());
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Empty database, rate limiters, outbox; clock frozen at DEFAULT_NOW. Runs before every test. */
export async function resetStack(): Promise<void> {
  await expectHook("POST", "/reset", 204, {});
  await expectHook("DELETE", "/emails", 204);
  await setClock(DEFAULT_NOW);
}

export async function hooksAvailable(): Promise<{
  status: number;
  text: string;
}> {
  const r = await hook("POST", "/reset", {});
  return { status: r.status, text: r.text };
}

// ------------------------------------------------------------ outbox
export interface CapturedEmail {
  to: string;
  subject: string;
  kind: string;
  priority: boolean;
  links: string[];
  sentAt: string;
}

export async function emails(to?: string): Promise<CapturedEmail[]> {
  const q = to ? `?to=${encodeURIComponent(to)}` : "";
  const json = (await expectHook("GET", `/emails${q}`, 200)) as {
    items: CapturedEmail[];
  };
  return json.items;
}

export async function clearEmails(): Promise<void> {
  await expectHook("DELETE", "/emails", 204);
}

/** The newest captured email of `kind` to `to` (throws with the outbox listing if none). */
export async function lastEmail(
  to: string,
  kind: string,
): Promise<CapturedEmail> {
  const all = await emails(to);
  const hit = [...all].reverse().find((e) => e.kind === kind);
  if (!hit)
    throw new Error(
      `no ${kind} email to ${to}; outbox for that address: [${all.map((e) => e.kind).join(", ")}]`,
    );
  return hit;
}

/** The `#token=` of a link (link tokens are in the fragment, auth.md §4). */
export function tokenFromLink(link: string): string {
  const m = /#token=([A-Za-z0-9_-]+)$/.exec(link);
  if (!m?.[1])
    throw new Error(`link has no #token= fragment: ${new URL(link).pathname}`);
  return m[1];
}

// ------------------------------------------------------------ sign-up invites and test login
/** POST /api/_test/signup-invites: same as the admin command, but returns the token. */
export async function signupInvite(email: string): Promise<string> {
  const json = (await expectHook("POST", "/signup-invites", 201, {
    email,
  })) as { token: string };
  return json.token;
}

/** POST /api/_test/login: an active session without password or MFA (reauth_at = now). */
export async function testLogin(
  email: string,
  label?: string,
): Promise<ApiClient> {
  const client = new ApiClient(label ?? email.split("@")[0]);
  const r = await rawRequest(
    "POST",
    "/api/_test/login",
    {
      host: appHost,
      "content-type": "application/json",
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36",
    },
    Buffer.from(JSON.stringify({ email })),
  );
  if (r.status !== 200)
    throw new Error(
      `test login for a factory user failed: ${r.status} ${r.text.slice(0, 200)}`,
    );
  const cookie = ([] as string[])
    .concat(r.headers["set-cookie"] ?? [])
    .find((c) => c.startsWith("ss_sid="));
  client.sessionToken = cookie?.split(";")[0]?.slice("ss_sid=".length) ?? null;
  const body = JSON.parse(r.text) as {
    csrfToken: string;
    user: { id: string };
  };
  client.csrfToken = body.csrfToken;
  client.userId = body.user.id;
  return client;
}

export type { ApiResponse };
