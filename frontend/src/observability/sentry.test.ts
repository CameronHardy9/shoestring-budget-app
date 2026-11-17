// The real SDK, end to end: init with this app's options and an in-memory
// transport, then capture hostile errors and read the envelopes it would send.
import {
  addBreadcrumb,
  captureException,
  createTransport,
  flush,
  init,
  type BrowserOptions,
} from "@sentry/browser";
import { afterAll, describe, expect, it } from "vitest";
import { sentryOptions } from "./sentry.ts";

const USER = "01a1e620-e22d-7090-96c4-741f12e76d63";
// A contract-shaped link token (64 base64url chars), made at run time.
const TOKEN = (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
const options = sentryOptions({
  dsn: `https://${crypto.randomUUID().replaceAll("-", "")}@o123.ingest.us.sentry.io/456`,
  release: "abc123",
  routeOf: (p) => (p.startsWith("/budgets/") ? "/budgets/:budgetId" : "(none)"),
  userId: () => USER,
});

const sent: string[] = [];

describe("Sentry options (ARCHITECTURE Error tracking, F-06, F-07)", () => {
  it("collect no PII, trace nothing and use only the listed integrations", () => {
    expect(options.tracesSampleRate).toBe(0);
    expect(options.defaultIntegrations).toBe(false);
    expect(options.sendClientReports).toBe(false);
    expect(options.dataCollection).toEqual({
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
    });
    const names = (options.integrations as { name: string }[]).map(
      (i) => i.name,
    );
    expect(names).toEqual([
      "GlobalHandlers",
      "BrowserApiErrors",
      "LinkedErrors",
      "Dedupe",
      "Breadcrumbs",
    ]);
  });
});

describe("what the SDK actually sends", () => {
  afterAll(() => {
    window.history.replaceState(null, "", "/");
  });

  it("holds no token, query, email, name or amount, from a page whose URL still has them", async () => {
    // As if capture had not run yet: the worst case F-50 guards against.
    window.history.replaceState(
      null,
      "",
      `/budgets/${USER}?month=2026-11#token=${TOKEN}`,
    );
    const testOptions: BrowserOptions = {
      ...options,
      transport: (o) =>
        createTransport(o, (request) => {
          sent.push(
            typeof request.body === "string"
              ? request.body
              : new TextDecoder().decode(request.body),
          );
          return Promise.resolve({ statusCode: 200 });
        }),
    };
    init(testOptions);
    addBreadcrumb({
      category: "fetch",
      type: "http",
      data: {
        method: "POST",
        url: `/api/budgets/${USER}/transactions?payee=Pharmacy#token=${TOKEN}`,
        status_code: 502,
      },
    });
    addBreadcrumb({ category: "ui.click", message: "Delete Pharmacy $45.00" });
    addBreadcrumb({ category: "console", message: "alice@example.test" });
    captureException(
      Object.assign(
        new SyntaxError(
          `Unexpected token 'P', "Pharmacy $45.00 alice@example.test Alice Example" is not valid JSON`,
        ),
        { requestId: "4f1c2d3e-aaaa-bbbb-cccc-000000000001" },
      ),
    );
    // F-59: a frame-shaped line in a multi-line message becomes a "frame"
    // in V8; none of its text may be sent.
    captureException(
      new Error(
        "Unexpected token\n    at alice@example.test Pharmacy (https://evil.example/x.js?token=abc:1:2)",
      ),
    );
    // An allowed message: kept, minus React's decoder args (values).
    captureException(
      new Error(
        `Minified React error #31; visit https://react.dev/errors/31?args[]=alice%40example.test&args[]=Pharmacy%20%2445.00 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.`,
      ),
    );
    await flush(2000);

    expect(sent.length).toBeGreaterThan(0);
    const all = sent.join("\n");
    for (const secret of [
      TOKEN,
      "token=",
      "month=",
      "payee=",
      "Pharmacy",
      "45.00",
      "alice%40example.test",
      "alice@example.test",
      "Alice Example",
      "evil.example",
    ])
      expect(all).not.toContain(secret);
    expect(all).toContain('"requestId":"4f1c2d3e-aaaa-bbbb-cccc-000000000001"');
    expect(all).toContain('"route":"/budgets/:budgetId"');
    expect(all).toContain(`"user":{"id":"${USER}"}`);
    expect(all).toContain('"release":"abc123"');
    expect(all).toContain(
      '"value":"Minified React error #31; visit https://react.dev/errors/31 for the full message',
    );
    expect(all).toContain('"value":"[message removed]"');
    expect(all).not.toContain("args[]");
  });
});
