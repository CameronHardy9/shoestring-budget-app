// F-07 / F-06: what reaches Sentry is checked on the wire (the serialized
// envelopes the real SDK would send), with hostile fixtures.
import * as Sentry from "@sentry/node";
import { DalError } from "@shoestring/db";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { makeHarness } from "../test-support/harness.ts";
import type { Harness } from "../test-support/harness.ts";
import {
  ALERTS,
  NO_TRACKING,
  PURGE_MONITOR,
  WITHHELD,
  framesFrom,
  initErrorTracker,
  safeFilename,
  scrubEvent,
  sentryOptions,
} from "./error-tracker.ts";
import type { ErrorTracker } from "./error-tracker.ts";

const DSN = "https://publickey123@o1.ingest.us.sentry.io/456";
const ROOT = "/srv/shoestring";

// Values that must never leave the process.
const PAYEE = "Pharmacy";
const MEMO = "therapy copay";
const AMOUNT = "4500";
const EMAIL = "pat@example.test";
const SESSION = "SESSIONtoken0123456789abcdefghijklmnopqrstu";
const CSRF = "CSRFtoken0123456789";
const BEARER = "BEARERsecret0123456789";
const PASSWORD = "hunter2 correct horse";
const HOSTILE = [
  PAYEE,
  MEMO,
  AMOUNT,
  EMAIL,
  SESSION,
  CSRF,
  BEARER,
  PASSWORD,
  "Failing row",
  "SELECT",
  "$1",
];

interface Item {
  type: string;
  payload: Record<string, unknown>;
}

/** Real SDK, in-memory transport: returns the raw envelopes and their parsed items. */
async function tracker(): Promise<{
  t: ErrorTracker;
  raw: string[];
  items: () => Item[];
}> {
  const raw: string[] = [];
  const t = await initErrorTracker({
    dsn: DSN,
    release: "abc123",
    environment: "production",
    root: ROOT,
    transport: (options) =>
      Sentry.createTransport(options, (req) => {
        raw.push(
          typeof req.body === "string"
            ? req.body
            : new TextDecoder().decode(req.body),
        );
        return Promise.resolve({ statusCode: 200 });
      }),
  });
  const items = () =>
    raw.flatMap((env) => {
      const lines = env.split("\n").filter((l) => l.trim() !== "");
      const out: Item[] = [];
      for (let i = 1; i + 1 < lines.length; i += 2) {
        const header = JSON.parse(lines[i]!) as { type: string };
        out.push({
          type: header.type,
          payload: JSON.parse(lines[i + 1]!) as Record<string, unknown>,
        });
      }
      return out;
    });
  return { t, raw, items };
}

/** A pg DatabaseError as the driver throws it (F-07 fixture): PII in message, detail, where, query and parameters. */
function dbError(): Error {
  return Object.assign(
    new Error(
      `new row for relation "splits" violates check constraint: ${PAYEE} ${MEMO} ${AMOUNT}`,
    ),
    {
      name: "error",
      code: "23514",
      constraint: "splits_amount_check",
      table: "splits",
      column: "amount_cents",
      schema: "public",
      severity: "ERROR",
      detail: `Failing row contains (0193, '${PAYEE}', '${MEMO}', ${AMOUNT}, ${EMAIL}).`,
      where: `SQL statement "SELECT 1 FROM splits WHERE memo = '${MEMO}'"`,
      hint: `Check ${EMAIL}`,
      query:
        "INSERT INTO splits (payee, memo, amount_cents) VALUES ($1, $2, $3)",
      parameters: [PAYEE, MEMO, Number(AMOUNT)],
      stack: `error: new row for relation "splits" violates check constraint: ${PAYEE} ${MEMO} ${AMOUNT}\n    at Parser.parseErrorMessage (/srv/shoestring/node_modules/pg-protocol/dist/parser.js:285:98)\n    at createSplit (/srv/shoestring/dist/server.js:1200:15)\n    at /Users/someone/secret-project/x.js:1:1`,
    },
  );
}

function zodError(): Error {
  const r = z
    .strictObject({ payee: z.number(), memo: z.literal("x") })
    .safeParse({ payee: PAYEE, memo: MEMO, extra: EMAIL });
  if (r.success) throw new Error("fixture must fail");
  // zod 4 omits input by default; a careless caller could have kept it.
  return Object.assign(r.error, { received: PAYEE, input: { memo: MEMO } });
}

function expectClean(raw: string[]): void {
  const all = raw.join("\n");
  for (const h of HOSTILE) expect(all, `leaked ${h}`).not.toContain(h);
  expect(all).not.toContain("/Users/");
  expect(all).not.toMatch(
    /"(request|breadcrumbs|extra|contexts|server_name|modules)"\s*:/,
  );
}

afterEach(async () => {
  await Sentry.close(100);
});

describe("Sentry options (F-06, F-07)", () => {
  it("pins every privacy setting", () => {
    const o = sentryOptions({
      dsn: DSN,
      release: "r",
      environment: "production",
    });
    expect(o).toMatchObject({
      defaultIntegrations: false,
      integrations: [],
      tracesSampleRate: 0,
      includeLocalVariables: false,
      maxBreadcrumbs: 0,
      attachStacktrace: false,
      sendClientReports: false,
      enableOpenTelemetrySetup: false,
      enableRuntimeChannelInjection: false,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        databaseQueryData: false,
        queues: false,
        stackFrameVariables: false,
        frameContextLines: 0,
      },
    });
    expect(o.beforeBreadcrumb?.({ message: EMAIL }, {})).toBeNull();
  });

  it("without SENTRY_DSN it is the no-op tracker", async () => {
    expect(
      await initErrorTracker({ dsn: null, release: "r", environment: "test" }),
    ).toBe(NO_TRACKING);
    expect(Sentry.isInitialized()).toBe(false);
  });
});

describe("captureError: built from the F-07 allowlist only", () => {
  it("a DB error with PII in message, detail, where, hint, query and parameters", async () => {
    const { t, raw, items } = await tracker();
    t.captureError(dbError(), {
      requestId: "01a1e592-acb3-7088-b730-d089561e5bd7",
      userId: "01a1d7ab-0000-7000-8000-000000000001",
      route: "/api/budgets/:budgetId/transactions",
    });
    await t.flush();
    expectClean(raw);
    const [event] = items().filter((i) => i.type === "event");
    expect(event!.payload).toMatchObject({
      level: "error",
      release: "abc123",
      environment: "production",
      tags: {
        requestId: "01a1e592-acb3-7088-b730-d089561e5bd7",
        userId: "01a1d7ab-0000-7000-8000-000000000001",
        route: "/api/budgets/:budgetId/transactions",
      },
      user: { id: "01a1d7ab-0000-7000-8000-000000000001" },
    });
    const ex = (
      event!.payload.exception as { values: Record<string, unknown>[] }
    ).values[0]!;
    expect(ex.type).toBe("error");
    expect(ex.value).toBe(
      "code=23514 constraint=splits_amount_check table=splits column=amount_cents",
    );
    expect((ex.stacktrace as { frames: unknown[] }).frames).toEqual(
      [
        {
          filename: "x.js",
          function: undefined,
          lineno: 1,
          colno: 1,
          in_app: true,
        },
        {
          filename: "app:///dist/server.js",
          function: "createSplit",
          lineno: 1200,
          colno: 15,
          in_app: true,
        },
        {
          filename: "node_modules/pg-protocol/dist/parser.js",
          function: "Parser.parseErrorMessage",
          lineno: 285,
          colno: 98,
          in_app: false,
        },
      ].map((f) => JSON.parse(JSON.stringify(f)) as unknown),
    );
  });

  it("a zod error with received values: only the name and frames", async () => {
    const { t, raw, items } = await tracker();
    t.captureError(zodError(), {
      requestId: "r-1",
      userId: null,
      route: "/api/me",
    });
    await t.flush();
    expectClean(raw);
    const [event] = items().filter((i) => i.type === "event");
    const ex = (
      event!.payload.exception as { values: Record<string, unknown>[] }
    ).values[0]!;
    expect([ex.type, ex.value]).toEqual(["ZodError", WITHHELD]);
    expect(event!.payload.user).toBeUndefined();
    expect(event!.payload.tags).toEqual({ requestId: "r-1", route: "/api/me" });
  });

  it("an error the SDK serializes itself (uncaught) is rebuilt by beforeSend: message dropped", async () => {
    const { t, raw, items } = await tracker();
    Sentry.captureException(dbError(), {
      extra: { body: { password: PASSWORD } },
      tags: { email: EMAIL },
      user: { email: EMAIL, ip_address: "203.0.113.9" },
    });
    Sentry.captureMessage(`free text ${EMAIL}`);
    await t.flush();
    expectClean(raw);
    expect(raw.join("")).not.toContain("203.0.113.9");
    const events = items().filter((i) => i.type === "event");
    expect(events).toHaveLength(2);
    const ex = (
      events[0]!.payload.exception as { values: Record<string, unknown>[] }
    ).values.at(-1)!;
    expect(ex.value).toBe(WITHHELD);
    expect(events[1]!.payload.message).toBeUndefined();
  });

  // F-59: V8 repeats the whole message in the stack; the SDK's own parser
  // skips only its first line. Neither path may turn message lines into frames.
  const fakeFrameError = () =>
    new Error(
      `failed for ${EMAIL}\n    at ${PAYEE} (${EMAIL}:1:2)\n    at ${MEMO} (x.js:3:4)\n    at evil.js:5:6`,
    );
  const framesOf = (it: Item) =>
    (
      it.payload.exception as {
        values: { stacktrace?: { frames: Record<string, unknown>[] } }[];
      }
    ).values.flatMap((v) => v.stacktrace?.frames ?? []);

  for (const path of ["captureError", "uncaught (SDK-built)"] as const) {
    it(`a multi-line message with fake frames: none reaches Sentry (${path})`, async () => {
      const { t, raw, items } = await tracker();
      if (path === "captureError")
        t.captureError(fakeFrameError(), {
          requestId: "r-1",
          userId: null,
          route: null,
        });
      else Sentry.captureException(fakeFrameError());
      await t.flush();
      expectClean(raw);
      for (const leak of ["x.js", "evil.js", "copay"])
        expect(raw.join("\n")).not.toContain(leak);
      const [event] = items().filter((i) => i.type === "event");
      const frames = framesOf(event!);
      expect(frames.length).toBeGreaterThan(0);
      // Only this file's real frames (base name: the repo is outside ROOT).
      expect(frames.at(-1)).toMatchObject({
        filename: "error-tracker.test.ts",
      });
    });
  }

  // F-62: a message shortened after `.stack` was read leaves V8's old header;
  // no frame at all is sent then (fail closed), on either path.
  for (const path of ["captureError", "uncaught (SDK-built)"] as const) {
    it(`a message shortened after the stack was read: no frames reach Sentry (${path})`, async () => {
      const { t, raw, items } = await tracker();
      const e = fakeFrameError();
      expect(e.stack).toContain("copay"); // fixes the header
      e.message = "failed";
      if (path === "captureError")
        t.captureError(e, { requestId: "r-1", userId: null, route: null });
      else Sentry.captureException(e);
      await t.flush();
      expectClean(raw);
      for (const leak of ["x.js", "evil.js", "copay"])
        expect(raw.join("\n")).not.toContain(leak);
      const [event] = items().filter((i) => i.type === "event");
      expect(event).toBeDefined();
      expect(framesOf(event!)).toEqual([]);
    });
  }

  it("beforeSend drops function names that are not identifiers", () => {
    const e = scrubEvent(
      {
        exception: {
          values: [
            {
              type: "Error",
              value: "x",
              stacktrace: {
                frames: [
                  {
                    filename: "/srv/shoestring/dist/a.js",
                    function: `${MEMO} ${EMAIL}`,
                    lineno: 1,
                  },
                  {
                    filename: "/srv/shoestring/dist/b.js",
                    function: "new Foo.bar",
                    lineno: 2,
                  },
                ],
              },
            },
          ],
        },
      },
      ROOT,
    );
    expect(e.exception!.values![0]!.stacktrace!.frames).toEqual([
      { filename: "app:///dist/a.js", lineno: 1 },
      { filename: "app:///dist/b.js", function: "new Foo.bar", lineno: 2 },
    ]);
  });

  it("tags and user only when they have the expected shape", () => {
    const e = scrubEvent(
      {
        tags: {
          requestId: `x ${EMAIL}`,
          userId: EMAIL,
          route: `/api/me?token=${SESSION}`,
          other: "y",
        },
        user: { id: EMAIL },
        request: {
          url: `https://app.test/api/me?token=${SESSION}`,
          cookies: { sid: SESSION },
        },
        fingerprint: ["ok", `bad ${EMAIL}`],
      },
      ROOT,
    );
    expect(e).toEqual({ fingerprint: ["ok"] });
  });
});

describe("the HTTP pipeline: 5xx captured, 4xx never", () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it("a request with cookies, CSRF, Authorization and a body: none of it is sent", async () => {
    const { t, raw, items } = await tracker();
    const fail = dbError();
    h = await makeHarness({
      errors: t,
      dal: { users: { updateDisplayName: () => Promise.reject(fail) } },
    });
    const s = h.sessions.add({
      userId: "01a1d7ab-0000-7000-8000-000000000001",
    });
    const r = await h.req("PATCH", "/api/me", {
      auth: s,
      body: { displayName: `${PAYEE} ${PASSWORD}` },
      headers: {
        authorization: `Bearer ${BEARER}`,
        "x-request-id": "client-req-1",
      },
    });
    expect(r.statusCode).toBe(500);
    await t.flush();
    expectClean(raw);
    for (const secret of [s.token, s.csrf, "client-req-1x"])
      expect(raw.join("")).not.toContain(secret);
    const events = items().filter((i) => i.type === "event");
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.tags).toEqual({
      requestId: r.headers["x-request-id"],
      userId: "01a1d7ab-0000-7000-8000-000000000001",
      route: "/api/me",
    });
  });

  it("a valid query string on a failing route: only the route template is sent", async () => {
    const { t, raw, items } = await tracker();
    const B = "01a1d7ab-0000-7000-8000-0000000000b1";
    const CATEGORY = "01a1d7ab-0000-7000-8000-0000000000c7";
    h = await makeHarness({
      errors: t,
      dal: {
        requireMembership: ((userId: string, budgetId: string) =>
          Promise.resolve({ budgetId, userId, role: "owner" })) as never,
        transactions: { listTransactions: () => Promise.reject(dbError()) },
      },
    });
    const s = h.sessions.add({
      userId: "01a1d7ab-0000-7000-8000-000000000001",
    });
    const r = await h.req(
      "GET",
      `/api/budgets/${B}/transactions?month=2024-02&categoryId=${CATEGORY}&limit=7`,
      { auth: s },
    );
    expect(r.statusCode).toBe(500);
    await t.flush();
    expectClean(raw);
    const all = raw.join("");
    for (const v of [CATEGORY, B, "month=", "2024-02", "limit=7", "?"])
      expect(all).not.toContain(v);
    expect(items().find((i) => i.type === "event")!.payload.tags).toMatchObject(
      {
        route: "/api/budgets/:budgetId/transactions",
      },
    );
  });

  it("contract 4xx (validation, not found, conflict, auth) never reach Sentry", async () => {
    const { t, raw } = await tracker();
    h = await makeHarness({
      errors: t,
      dal: {
        users: {
          updateDisplayName: () => Promise.reject(new DalError("NOT_FOUND")),
        },
      },
    });
    const s = h.sessions.add({
      userId: "01a1d7ab-0000-7000-8000-000000000001",
    });
    const codes = [
      (
        await h.req("PATCH", "/api/me", {
          auth: s,
          body: { displayName: "Pat" },
        })
      ).statusCode,
      (
        await h.req("PATCH", "/api/me", {
          auth: s,
          body: { displayName: "Pat", extra: EMAIL },
        })
      ).statusCode,
      (await h.req("PATCH", "/api/me", { body: { displayName: "Pat" } }))
        .statusCode,
    ];
    expect(codes.every((c) => c >= 400 && c < 500)).toBe(true);
    await t.flush();
    expect(raw).toEqual([]);
  });
});

describe("alerts and check-ins", () => {
  it("A6: fixed message, fingerprint and level; nothing else", async () => {
    const { t, raw, items } = await tracker();
    t.alert(ALERTS.emailQuotaWarning);
    t.alert(ALERTS.emailQuotaReached);
    await t.flush();
    const events = items().filter((i) => i.type === "event");
    expect(
      events.map((e) => [
        e.payload.level,
        e.payload.message,
        e.payload.fingerprint,
      ]),
    ).toEqual([
      ["warning", ALERTS.emailQuotaWarning.message, ["email-quota-threshold"]],
      ["error", ALERTS.emailQuotaReached.message, ["email-quota-threshold"]],
    ]);
    expect(raw.join("")).not.toMatch(/"(to|kind|email)"\s*:/);
  });

  it("A3: in_progress then ok/error with the README schedule and margins", async () => {
    const { t, items } = await tracker();
    const c = t.startCheckIn(PURGE_MONITOR);
    c.finish("error");
    c.finish("ok"); // ignored: one result per run
    await t.flush();
    const checkIns = items()
      .filter((i) => i.type === "check_in")
      .map((i) => i.payload);
    expect(checkIns).toHaveLength(2);
    expect(checkIns[0]).toMatchObject({
      monitor_slug: "purge",
      status: "in_progress",
      release: "abc123",
      environment: "production",
      monitor_config: {
        schedule: { type: "crontab", value: "0 8 * * *" },
        checkin_margin: 60,
        max_runtime: 15,
        timezone: "UTC",
        failure_issue_threshold: 1,
        recovery_threshold: 1,
      },
    });
    expect(checkIns[1]).toMatchObject({
      monitor_slug: "purge",
      status: "error",
      check_in_id: checkIns[0]!.check_in_id,
    });
    expect(typeof checkIns[1]!.duration).toBe("number");
  });
});

describe("frame helpers", () => {
  it("strips machine paths; keeps app:///, node_modules/ and node: paths", () => {
    expect(safeFilename(`file://${ROOT}/dist/server.js`, ROOT)).toBe(
      "app:///dist/server.js",
    );
    expect(
      safeFilename("/Users/someone/proj/node_modules/pg/lib/client.js", ROOT),
    ).toBe("node_modules/pg/lib/client.js");
    expect(safeFilename("/home/someone/elsewhere/file.js", ROOT)).toBe(
      "file.js",
    );
    expect(safeFilename("node:internal/process/task_queues", ROOT)).toBe(
      "node:internal/process/task_queues",
    );
    expect(safeFilename("C:\\Users\\someone\\x.js", ROOT)).toBeUndefined();
  });

  it("keeps a frame's location but not a function name with spaces", () => {
    expect(framesFrom([`at ${MEMO} (a.js:1:2)`], ROOT)).toEqual([
      { filename: "a.js", lineno: 1, colno: 2, in_app: true },
    ]);
  });

  it("ignores lines that are not frames", () => {
    expect(
      framesFrom(["at nope", `${EMAIL}:1:1`, "at f (a.js:1:2)"], ROOT),
    ).toEqual([
      { filename: "a.js", function: "f", lineno: 1, colno: 2, in_app: true },
    ]);
  });
});
