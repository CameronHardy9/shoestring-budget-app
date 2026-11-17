// Sentry no-PII gate on the PRODUCTION build (ARCHITECTURE "Error tracking";
// F-06, F-07, F-50; owner ruling round 8: only reviewed safe error messages).
//
// The bundle is built with VITE_SENTRY_DSN = E2E_SENTRY_DSN, a fake DSN on a
// reserved .test host that never resolves (scripts/build-prod-frontend.mjs),
// and the backend's CSP names that host in connect-src. Every request to it is
// intercepted here, so the envelopes the real SDK would send are checked
// byte for byte, after the browser's CSP has allowed (or blocked) them:
//   - only allowlisted keys, at every level (scrub.ts rebuilds each event from
//     an allowlist; this is the end-to-end proof that nothing the SDK adds
//     after beforeSend reopens it). An SDK upgrade that adds a field fails
//     here on purpose: someone must look at it;
//   - none of the data the page holds or the error carries: email, name,
//     payee, memo, amount, budget and category names, query values, the
//     session cookie, link tokens, "token=";
//   - URLs cut at ? and #;
//   - zero CSP violations (the fixture, on every document; checked again
//     right after the envelopes arrive), including WebKit frame-src for the
//     SDK's hidden about:blank iframe.
// Triggers: an uncaught error, an unhandled rejection, an error buffered
// before the SDK loads, and a non-contract API response (with its requestId).
import { randomBytes, randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { e2eSentry } from "../../support/env.ts";
import { findAmount } from "../../support/pii-scan.ts";
import {
  createBudget,
  createTransaction,
  createUser,
} from "../../support/factories.ts";
import type { TestBudget, TestUser } from "../../support/factories.ts";
import {
  expect,
  expectNoCspViolations,
  flushCspViolations,
  signInAs,
  test,
} from "../fixtures.ts";
import type { CspViolations } from "../fixtures.ts";

/** scrub.ts REDACTED: what every message outside the safe patterns becomes. */
const REDACTED = "[message removed]";

// ------------------------------------------------------------ envelopes
interface Captured {
  url: string;
  referer: string | undefined;
  body: string;
}

interface Item {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

/** Intercepts every request to the fake ingest host and answers 200. */
async function interceptSentry(page: Page): Promise<Captured[]> {
  const { ingestOrigin } = e2eSentry();
  const captured: Captured[] = [];
  await page.route(`${ingestOrigin}/**`, async (route) => {
    const req = route.request();
    captured.push({
      url: req.url(),
      referer: req.headers().referer,
      body: req.postDataBuffer()?.toString("utf8") ?? "",
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: "{}",
    });
  });
  return captured;
}

/** Newline-delimited envelope: header, then (item header, payload) pairs. */
function parseEnvelope(c: Captured): {
  header: Record<string, unknown>;
  items: Item[];
} {
  const lines = c.body.split("\n").filter((l) => l !== "");
  const parse = (l: string) => JSON.parse(l) as Record<string, unknown>;
  const [head, ...rest] = lines;
  expect(head, "envelope header line").toBeDefined();
  expect(rest.length % 2, "every item header has a payload line").toBe(0);
  const items: Item[] = [];
  for (let i = 0; i < rest.length; i += 2)
    items.push({ header: parse(rest[i]!), payload: parse(rest[i + 1]!) });
  return { header: parse(head!), items };
}

/** All events in the captured envelopes (after the structure is checked). */
function events(captured: Captured[]): Record<string, unknown>[] {
  return captured.flatMap((c) => parseEnvelope(c).items.map((i) => i.payload));
}

/** Waits until at least `n` events have arrived. */
async function waitForEvents(captured: Captured[], n: number): Promise<void> {
  await expect
    .poll(() => events(captured).length, {
      message: `${n} Sentry event(s) reach the ingest host`,
    })
    .toBeGreaterThanOrEqual(n);
}

// ------------------------------------------------------------ allowlists
// scrub.ts scrubEvent's output keys; `sdk` gains integrations, packages and
// settings inside the SDK after beforeSend (checked below).
const EVENT_KEYS = new Set([
  "breadcrumbs",
  "environment",
  "event_id",
  "exception",
  "level",
  "platform",
  "release",
  "request",
  "sdk",
  "tags",
  "timestamp",
  "transaction",
  "user",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function keysWithin(
  obj: unknown,
  allowed: readonly string[],
  where: string,
): void {
  expect(typeof obj === "object" && obj !== null, `${where} is an object`).toBe(
    true,
  );
  const extra = Object.keys(obj as object).filter((k) => !allowed.includes(k));
  expect(extra, `keys outside the allowlist in ${where}`).toEqual([]);
}

/** Fields that carry URLs or paths: each must be cut at ? and # (F-06). */
function urlFields(event: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string") out.push(v);
  };
  add(event.transaction);
  add((event.tags as Record<string, unknown> | undefined)?.route);
  const ex = event.exception as
    | { values?: { stacktrace?: { frames?: { filename?: unknown }[] } }[] }
    | undefined;
  for (const v of ex?.values ?? [])
    for (const f of v.stacktrace?.frames ?? []) add(f.filename);
  for (const b of (event.breadcrumbs ?? []) as {
    data?: Record<string, unknown>;
  }[]) {
    add(b.data?.url);
    add(b.data?.from);
    add(b.data?.to);
  }
  return out;
}

/** The whole envelope request: structure, allowlists and URLs. */
function expectAllowlisted(c: Captured, userAgent: string): void {
  const { ingestOrigin, projectId, publicKey } = e2eSentry();
  const url = new URL(c.url);
  expect(url.origin + url.pathname, "envelope endpoint").toBe(
    `${ingestOrigin}/api/${projectId}/envelope/`,
  );
  expect(url.searchParams.get("sentry_key")).toBe(publicKey);
  // Sentry's transport sends strict-origin: never the page path or fragment.
  if (c.referer !== undefined)
    expect(
      new URL(c.referer).pathname + new URL(c.referer).search,
      "Referer",
    ).toBe("/");
  if (c.referer !== undefined) expect(c.referer).not.toContain("#");

  const { header, items } = parseEnvelope(c);
  keysWithin(header, ["event_id", "sent_at", "sdk"], "envelope header");
  keysWithin(header.sdk, ["name", "version"], "envelope header sdk");
  for (const item of items) {
    // Events only: no sessions, client reports, attachments or replays.
    expect(item.header, "item header").toEqual({ type: "event" });
    const e = item.payload;
    keysWithin(e, [...EVENT_KEYS], "event");
    keysWithin(
      e.sdk,
      ["name", "version", "integrations", "packages", "settings"],
      "event sdk",
    );
    // The SDK tells Sentry never to infer the client IP from the connection.
    expect((e.sdk as { settings?: unknown }).settings).toEqual({
      infer_ip: "never",
    });
    keysWithin(e.tags, ["route", "requestId"], "tags");
    if (e.user !== undefined) {
      keysWithin(e.user, ["id"], "user");
      expect((e.user as { id: string }).id).toMatch(UUID);
    }
    expect(e.request, "request: the browser only").toEqual({
      headers: { "User-Agent": userAgent },
    });
    const values = (e.exception as { values?: unknown[] } | undefined)?.values;
    expect(values?.length, "the event has an exception").toBeGreaterThan(0);
    for (const v of values ?? []) {
      keysWithin(v, ["type", "value", "mechanism", "stacktrace"], "exception");
      const { mechanism, stacktrace } = v as {
        mechanism?: unknown;
        stacktrace?: { frames?: unknown[] };
      };
      if (mechanism !== undefined)
        keysWithin(mechanism, ["type", "handled"], "mechanism");
      if (stacktrace !== undefined)
        keysWithin(stacktrace, ["frames"], "stacktrace");
      for (const f of stacktrace?.frames ?? [])
        keysWithin(
          f,
          ["filename", "function", "lineno", "colno", "in_app"],
          "stack frame",
        );
    }
    for (const b of (e.breadcrumbs ?? []) as Record<string, unknown>[]) {
      keysWithin(
        b,
        ["category", "type", "level", "timestamp", "data"],
        "breadcrumb",
      );
      expect(["fetch", "xhr", "navigation"], "breadcrumb category").toContain(
        b.category,
      );
      keysWithin(
        b.data ?? {},
        b.category === "navigation"
          ? ["from", "to"]
          : ["method", "url", "status_code"],
        `${String(b.category)} breadcrumb data`,
      );
    }
    for (const u of urlFields(e))
      expect(u, "URLs are cut at ? and # (F-06)").not.toMatch(/[?#]/);
  }
}

// ------------------------------------------------------------ planted data
/** What the page holds and the hostile errors carry; none of it may leave. */
interface Planted {
  user: TestUser;
  budget: TestBudget;
  /** A value in the page URL's query string. */
  queryValue: string;
  /** Strings that must not appear anywhere in any envelope. */
  secrets: string[];
  /** A message carrying all of it. */
  hostile: string;
}

// $87.65: no ISO time (seconds < 60) or float timestamp can contain "87.65"
// standing alone. The patterns, and the IDs and positions masked before they
// run (a UUIDv7 can hold "-8765-"), are in support/pii-scan.ts.
const AMOUNT_CENTS = 8_765;

async function plant(page: Page): Promise<Planted> {
  const user = await createUser({
    prefix: "sentry",
    displayName: "Alice Example",
  });
  const budget = await createBudget(user, {
    name: "Example Household",
    categories: [
      { name: "Health Costs", kind: "expense", plannedCents: 20_000 },
    ],
  });
  await createTransaction(budget.scope, {
    date: "2026-11-10",
    categoryId: budget.categories["Health Costs"]!,
    amountCents: AMOUNT_CENTS,
    payee: "Pharmacy",
    memo: "therapy copay",
  });
  await signInAs(page, user.email);
  const session = (await page.context().cookies()).find(
    (c) => c.name === "ss_sid",
  );
  expect(session, "the browser is signed in").toBeDefined();
  // A link-token-shaped value (contract Token: 43-64 base64url), generated.
  const token = randomBytes(32).toString("base64url");
  const queryValue = `qv${randomBytes(8).toString("hex")}`;
  return {
    user,
    budget,
    queryValue,
    secrets: [
      user.email,
      user.email.split("@")[0]!,
      "Alice Example",
      "Pharmacy",
      "therapy copay",
      "Example Household",
      "Health Costs",
      queryValue,
      token,
      session!.value,
    ],
    hostile: `${user.email} Alice Example paid Pharmacy $87.65 (therapy copay) ref=${queryValue} token=${token}`,
  };
}

/** Opens the planted transaction list with a query value in the page URL. */
async function openTransactions(page: Page, p: Planted): Promise<void> {
  await page.goto(
    `/budgets/${p.budget.id}/transactions?month=2026-11&ref=${p.queryValue}`,
  );
  await expect(page.getByText("Pharmacy")).toBeVisible();
}

/** The SDK has started (main.tsx sets <html data-error-tracking="on">). */
async function sentryStarted(page: Page): Promise<void> {
  await page
    .locator('html[data-error-tracking="on"]')
    .waitFor({ state: "attached" });
}

/** Every envelope: allowlisted, and none of the planted data in any form. */
async function expectNoPii(
  page: Page,
  captured: Captured[],
  secrets: readonly string[],
  cspViolations: CspViolations,
): Promise<void> {
  const userAgent = await page.evaluate(() => navigator.userAgent);
  for (const c of captured) {
    expectAllowlisted(c, userAgent);
    const raw = `${c.url}\n${c.referer ?? ""}\n${c.body}`;
    for (const s of secrets)
      expect(raw.includes(s), `an envelope carries "${s.slice(0, 12)}…"`).toBe(
        false,
      );
    expect(raw, "no token= anywhere").not.toMatch(/token=/i);
    expect(raw, "no email address anywhere").not.toMatch(
      /[\w.+-]+@[\w-]+\.(test|example|com)\b/,
    );
    expect(
      findAmount(c.body)?.source ?? null,
      "no amount anywhere (outside UUIDs, 32-hex IDs and stack positions)",
    ).toBeNull();
  }
  // Numbers too, outside positions and times.
  const walk = (v: unknown, key: string): void => {
    if (
      typeof v === "number" &&
      !/^(lineno|colno|timestamp|status_code)$/.test(key)
    )
      expect(v, `number at ${key}`).not.toBe(AMOUNT_CENTS);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (typeof v === "object" && v !== null)
      for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(events(captured), "");
  // C3.1 at the moment the SDK has done its work (the fixture checks again).
  await flushCspViolations(page);
  expectNoCspViolations(cspViolations);
}

interface Exception {
  type: string;
  value: string;
  mechanism: { type: string; handled: boolean };
}

/** The single exception of the single event. */
function onlyException(captured: Captured[]): Exception {
  const all = events(captured);
  expect(all, "exactly one event").toHaveLength(1);
  const values = (all[0]!.exception as { values: unknown[] }).values;
  expect(values).toHaveLength(1);
  return values[0] as Exception;
}

/**
 * Init script (page side): at DOMContentLoaded, before Sentry loads, rejects
 * a promise and throws, both quoting `m`. Records whether error tracking was
 * already on.
 */
function earlyThrower(m: string): void {
  if (window !== window.top) return;
  document.addEventListener("DOMContentLoaded", () => {
    sessionStorage.setItem(
      "e2e-early-tracking",
      document.documentElement.dataset.errorTracking ?? "off",
    );
    void Promise.reject(new Error(`rejected ${m}`));
    throw new Error(`thrown ${m}`);
  });
}

/** The early events' messages by buffer mechanism (report.ts). */
function earlyEvents(captured: Captured[]): Record<string, string> {
  const all = events(captured);
  expect(all, "exactly the two early events").toHaveLength(2);
  const out: Record<string, string> = {};
  for (const e of all) {
    const [ex] = (e.exception as { values: Exception[] }).values;
    expect(ex!.mechanism.handled).toBe(false);
    out[ex!.mechanism.type] = ex!.value;
  }
  expect(Object.keys(out).sort()).toEqual(["onerror", "onunhandledrejection"]);
  return out;
}

/**
 * The early uncaught error's message as sent. Chromium hands report.ts the
 * Error, whose message the scrub removes. WebKit treats Playwright's init
 * scripts like a cross-origin script and mutes the error (ErrorEvent.error is
 * null), so report.ts sends its "Script error" stand-in, a safe pattern; the
 * hostile text never reaches the SDK at all there. The rejection (reason is
 * not muted) proves the scrub on both engines.
 */
function earlyErrorValue(browserName: string): string {
  return browserName === "webkit" ? "Script error" : REDACTED;
}

// ------------------------------------------------------------ the tests
test.describe("Sentry events carry no PII (F-06, F-07)", () => {
  test("an uncaught error is reported with its message removed and only allowlisted fields", async ({
    page,
    pageErrors,
    cspViolations,
  }) => {
    const captured = await interceptSentry(page);
    const p = await plant(page);
    await openTransactions(page, p);
    await sentryStarted(page);

    await page.evaluate((m) => {
      queueMicrotask(() => {
        throw new Error(m);
      });
    }, p.hostile);
    await waitForEvents(captured, 1);
    expect(pageErrors.take((m) => m === p.hostile)).toHaveLength(1);

    const ex = onlyException(captured);
    expect(ex.type).toBe("Error");
    expect(ex.value).toBe(REDACTED);
    expect(ex.mechanism.type).toMatch(/onerror$/);
    expect(ex.mechanism.handled).toBe(false);
    const event = events(captured)[0]!;
    expect(event.release).toBe("e2e");
    expect(event.transaction).toBe("/budgets/:budgetId/transactions");
    await expectNoPii(page, captured, p.secrets, cspViolations);
  });

  test("an unhandled rejection is reported with its message removed and only allowlisted fields", async ({
    page,
    pageErrors,
    cspViolations,
  }) => {
    const captured = await interceptSentry(page);
    const p = await plant(page);
    await openTransactions(page, p);
    await sentryStarted(page);

    await page.evaluate((m) => {
      void Promise.reject(new Error(m));
    }, p.hostile);
    await waitForEvents(captured, 1);
    // Chromium reports the rejection as a page error, WebKit does not.
    pageErrors.take((m) => m.includes(p.hostile));

    const ex = onlyException(captured);
    expect(ex.value).toBe(REDACTED);
    expect(ex.mechanism.type).toMatch(/onunhandledrejection$/);
    expect(ex.mechanism.handled).toBe(false);
    await expectNoPii(page, captured, p.secrets, cspViolations);
  });

  test("an error and a rejection thrown before the SDK loads are buffered, then sent once each, scrubbed", async ({
    page,
    pageErrors,
    cspViolations,
    browserName,
  }) => {
    const captured = await interceptSentry(page);
    const p = await plant(page);
    await page.addInitScript(earlyThrower, p.hostile);
    await openTransactions(page, p);
    await sentryStarted(page);
    await waitForEvents(captured, 2);
    pageErrors.take((m) => m.includes(p.hostile));
    expect(
      await page.evaluate(() => sessionStorage.getItem("e2e-early-tracking")),
      "the errors were thrown before error tracking started",
    ).toBe("off");

    // report.ts's buffer: one event per error, no duplicates once Sentry's
    // own handlers take over.
    const byMechanism = earlyEvents(captured);
    expect(byMechanism.onunhandledrejection).toBe(REDACTED);
    expect(byMechanism.onerror).toBe(earlyErrorValue(browserName));
    await expectNoPii(page, captured, p.secrets, cspViolations);
  });

  test("a non-contract API response (proxy 502 page) is reported with its requestId and the safe status message only", async ({
    page,
    cspViolations,
  }) => {
    const captured = await interceptSentry(page);
    const p = await plant(page);
    const requestId = randomUUID();
    // A proxy's HTML error page quoting data: not an ErrorBody, so the client
    // reports UnexpectedResponseError (api/client.ts).
    await page.route(
      (url) => url.pathname === `/api/budgets/${p.budget.id}/transactions`,
      (route) =>
        route.fulfill({
          status: 502,
          contentType: "text/html",
          headers: { "x-request-id": requestId },
          body: `<html><body>Bad gateway for ${p.hostile}</body></html>`,
        }),
    );
    await page.goto(
      `/budgets/${p.budget.id}/transactions?month=2026-11&ref=${p.queryValue}`,
    );
    await sentryStarted(page);
    await waitForEvents(captured, 1);

    // The list may retry; every report has the same shape.
    for (const e of events(captured)) {
      const [ex, ...more] = (e.exception as { values: unknown[] }).values as {
        type: string;
        value: string;
        mechanism: unknown;
      }[];
      expect(more).toHaveLength(0);
      expect(ex).toMatchObject({
        type: "UnexpectedResponseError",
        value: "Unexpected response (HTTP 502)",
        mechanism: { type: "api", handled: true },
      });
      expect(e.tags).toEqual({
        route: "/budgets/:budgetId/transactions",
        requestId,
      });
    }
    await expectNoPii(page, captured, p.secrets, cspViolations);
  });

  test("a message matching a reviewed safe pattern is kept; a look-alike carrying an email is removed", async ({
    page,
    pageErrors,
    cspViolations,
  }) => {
    const captured = await interceptSentry(page);
    const p = await plant(page);
    await openTransactions(page, p);
    await sentryStarted(page);
    const throwAsync = (m: string) =>
      page.evaluate((msg) => {
        queueMicrotask(() => {
          throw new Error(msg);
        });
      }, m);

    const safe = "Network request failed";
    const lookAlike = `Network request failed for ${p.user.email}`;
    await throwAsync(safe);
    await waitForEvents(captured, 1);
    await throwAsync(lookAlike);
    await waitForEvents(captured, 2);
    expect(pageErrors.take((m) => m === safe || m === lookAlike)).toHaveLength(
      2,
    );

    const values = events(captured).map(
      (e) => (e.exception as { values: { value: string }[] }).values[0]!.value,
    );
    expect(values).toEqual([safe, REDACTED]);
    await expectNoPii(page, captured, p.secrets, cspViolations);
  });
});

test.describe("F-50: an emailed link's token never reaches Sentry", () => {
  test("/reset-password#token=…: the fragment is gone before any other script, and early errors quoting it are sent without it", async ({
    page,
    pageErrors,
    cspViolations,
    browserName,
  }) => {
    const captured = await interceptSentry(page);
    const token = randomBytes(36).toString("base64url"); // 48 characters
    // A hostile early reader: it saw the hash at document start (before any
    // page script) and, at DOMContentLoaded, before the SDK loads, rejects a
    // promise and throws an error quoting it and the page URL.
    // It also records the hash when the boot script has run (DOMContentLoaded)
    // and when error tracking switches on.
    await page.addInitScript(() => {
      if (window !== window.top) return;
      const seenAtStart = location.hash;
      sessionStorage.setItem("e2e-hash-at-start", seenAtStart);
      // <html> may not exist yet at document start: observe the document.
      new MutationObserver(() => {
        if (document.documentElement.dataset.errorTracking === "on")
          sessionStorage.setItem("e2e-hash-at-sentry", location.hash);
      }).observe(document, {
        subtree: true,
        attributes: true,
        attributeFilter: ["data-error-tracking"],
      });
      document.addEventListener("DOMContentLoaded", () => {
        sessionStorage.setItem("e2e-hash-at-dcl", location.hash);
        void Promise.reject(
          new Error(`rejected early ${location.href} ${seenAtStart}`),
        );
        throw new Error(`thrown early ${location.href} ${seenAtStart}`);
      });
    });

    await page.goto(`/reset-password#token=${token}`);
    await sentryStarted(page);
    await waitForEvents(captured, 2);
    pageErrors.take((m) => m.includes(" early "));

    const state = await page.evaluate(() => ({
      hash: location.hash,
      href: location.href,
      atStart: sessionStorage.getItem("e2e-hash-at-start"),
      atDcl: sessionStorage.getItem("e2e-hash-at-dcl"),
      atSentry: sessionStorage.getItem("e2e-hash-at-sentry"),
    }));
    expect(state.atStart, "the link really carried the token").toBe(
      `#token=${token}`,
    );
    expect(state.hash).toBe("");
    expect(state.href).not.toContain(token);
    expect(state.atDcl, "stripped before DOMContentLoaded (boot script)").toBe(
      "",
    );
    expect(state.atSentry, "stripped before Sentry started").toBe("");

    const byMechanism = earlyEvents(captured);
    expect(byMechanism.onunhandledrejection).toBe(REDACTED);
    expect(byMechanism.onerror).toBe(earlyErrorValue(browserName));
    for (const e of events(captured))
      expect(e.transaction).toBe("/reset-password");
    await expectNoPii(page, captured, [token], cspViolations);
  });
});
