import type { ErrorEvent } from "@sentry/browser";
import { describe, expect, it } from "vitest";
import { NetworkError, UnexpectedResponseError } from "../api/errors.ts";
import { ERROR_COPY } from "../api/messages.ts";
import { SignOutError } from "../app/auth.tsx";
import { ReauthCancelled } from "../app/reauth.tsx";
import { sumCents } from "../lib/splits.ts";
import {
  pathOf,
  patternProblems,
  REDACTED,
  requestIdOf,
  SAFE_MESSAGES,
  safeMessage,
  scrubBreadcrumb,
  scrubEvent,
  stripReactArgs,
  stripUrl,
  type SafeMessage,
} from "./scrub.ts";

const routeOf = (p: string) =>
  p.startsWith("/budgets/") ? "/budgets/:budgetId" : p === "/" ? "/" : "(none)";
const USER = "01a1e620-e22d-7090-96c4-741f12e76d63";
const ORIGIN = "https://shoestring.example";
// A contract-shaped link token (64 base64url chars), made at run time.
const TOKEN = (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");

/** Everything a hostile event could carry; none of it may survive. */
const SECRETS = [
  TOKEN,
  "Pharmacy",
  "therapy copay",
  "45.00",
  "4500",
  "alice@example.test",
  "Alice Example",
  "203.0.113.7",
  "ss_sid",
  "month=2026-11",
  "Delete Pharmacy",
];

function hostileEvent(): ErrorEvent {
  return {
    type: undefined,
    event_id: "0123456789abcdef0123456789abcdef",
    timestamp: 1_800_000_000,
    platform: "javascript",
    level: "error",
    release: "abc123",
    environment: "production",
    sdk: { name: "sentry.javascript.browser", version: "11.10.0" },
    message: "alice@example.test paid Pharmacy $45.00",
    logentry: { message: "Alice Example" },
    exception: {
      values: [
        {
          type: "SyntaxError",
          value: `Unexpected token 'P', "Pharmacy therapy copay 4500" is not valid JSON`,
          mechanism: {
            type: "onerror",
            handled: false,
            data: { note: "alice@example.test" },
          },
          stacktrace: {
            frames: [
              {
                filename: `https://shoestring.example/assets/index-1a2b3c4d.js?token=${TOKEN}#token=${TOKEN}`,
                function: "Object.save",
                lineno: 1,
                colno: 4321,
                in_app: true,
                vars: { payee: "Pharmacy", amount: 4500 },
                context_line: "save({payee:'Pharmacy'})",
              },
              {
                filename: "https://shoestring.example/assets/x.js",
                function: "alice@example.test",
                lineno: 2,
              },
            ],
          },
        },
        {
          type: "Alice Example",
          value:
            "Non-Error promise rejection captured with value: alice@example.test",
        },
      ],
    },
    request: {
      url: `https://shoestring.example/reset-password?month=2026-11#token=${TOKEN}`,
      headers: { Cookie: "ss_sid=abc", Referer: `https://x/#token=${TOKEN}` },
      query_string: "month=2026-11",
    },
    user: {
      id: USER,
      email: "alice@example.test",
      username: "Alice Example",
      ip_address: "203.0.113.7",
    },
    tags: { email: "alice@example.test" },
    extra: { payee: "Pharmacy", memo: "therapy copay" },
    contexts: { custom: { payee: "Pharmacy" } },
    breadcrumbs: [
      {
        category: "ui.click",
        message: 'button[aria-label="Delete Pharmacy $45.00"]',
      },
      { category: "console", message: "alice@example.test", level: "log" },
      {
        category: "fetch",
        type: "http",
        timestamp: 1,
        data: {
          method: "GET",
          url: `https://shoestring.example/api/budgets/${USER}/transactions?month=2026-11&payee=Pharmacy#token=${TOKEN}`,
          status_code: 500,
          request_body_size: 4500,
          response: "alice@example.test",
        },
      },
      {
        category: "navigation",
        data: {
          from: `/reset-password#token=${TOKEN}`,
          to: `/budgets/${USER}?month=2026-11`,
        },
      },
    ],
  };
}

describe("URL scrubbing (F-06)", () => {
  it("cuts every URL at ? or #", () => {
    expect(stripUrl(`/signup#token=${TOKEN}`)).toBe("/signup");
    expect(stripUrl("https://a.example/x?y=1#z")).toBe("https://a.example/x");
    expect(stripUrl("https://a.example/x#a?b")).toBe("https://a.example/x");
    expect(pathOf(`https://a.example/api/x?token=${TOKEN}`)).toBe("/api/x");
    expect(pathOf("https://a.example")).toBe("/");
    expect(pathOf(`javascript:alert('${TOKEN}')`)).toBe("/");
  });
});

describe("event allowlist (F-06, F-07)", () => {
  const ctx = {
    routeOf,
    pathname: `/budgets/${USER}`,
    userId: USER,
    userAgent: "Mozilla/5.0 (iPhone)",
    origin: ORIGIN,
  };

  it("sends nothing financial, no email, name, token, query, IP or cookie", () => {
    const out = JSON.stringify(scrubEvent(hostileEvent(), {}, ctx));
    for (const secret of SECRETS) expect(out).not.toContain(secret);
    expect(out).not.toMatch(/[?#]/);
  });

  it("keeps only requestId, the opaque user ID, the route, the browser and the release", () => {
    const out = scrubEvent(
      hostileEvent(),
      {
        originalException: {
          requestId: "4f1c2d3e-aaaa-bbbb-cccc-000000000001",
        },
      },
      ctx,
    );
    expect(out.tags).toEqual({
      route: "/budgets/:budgetId",
      requestId: "4f1c2d3e-aaaa-bbbb-cccc-000000000001",
    });
    expect(out.transaction).toBe("/budgets/:budgetId");
    expect(out.user).toEqual({ id: USER });
    expect(out.request).toEqual({
      headers: { "User-Agent": "Mozilla/5.0 (iPhone)" },
    });
    expect(out.release).toBe("abc123");
    expect(Object.keys(out).sort()).toEqual(
      [
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
        "type",
        "user",
      ].sort(),
    );
    expect(out.message).toBeUndefined();
    expect(out.extra).toBeUndefined();
    expect(out.contexts).toBeUndefined();
  });

  it("removes error messages but keeps types and stack frames", () => {
    const [first, second] =
      scrubEvent(hostileEvent(), {}, ctx).exception?.values ?? [];
    expect(first).toEqual({
      type: "SyntaxError",
      value: REDACTED,
      mechanism: { type: "onerror", handled: false },
      stacktrace: {
        frames: [
          {
            filename: "https://shoestring.example/assets/index-1a2b3c4d.js",
            function: "Object.save",
            lineno: 1,
            colno: 4321,
            in_app: true,
          },
          { filename: "https://shoestring.example/assets/x.js", lineno: 2 },
        ],
      },
    });
    expect(second).toMatchObject({ type: "Error", value: REDACTED });
  });

  it("keeps the app's own status-only messages", () => {
    const event = hostileEvent();
    event.exception = {
      values: [
        {
          type: "UnexpectedResponseError",
          value: "Unexpected response (HTTP 502)",
        },
        { type: "ApiError", value: "INTERNAL" },
        { type: "NetworkError", value: "Network request failed" },
      ],
    };
    expect(
      scrubEvent(event, {}, ctx).exception?.values?.map((v) => v.value),
    ).toEqual([
      "Unexpected response (HTTP 502)",
      "INTERNAL",
      "Network request failed",
    ]);
  });

  it("drops a non-UUID user ID and a requestId outside the contract pattern", () => {
    const out = scrubEvent(
      hostileEvent(),
      { originalException: { requestId: "alice@example.test" } },
      { ...ctx, userId: "alice@example.test" },
    );
    expect(out.user).toBeUndefined();
    expect(out.tags).toEqual({ route: "/budgets/:budgetId" });
    expect(requestIdOf(new Error("x"))).toBeNull();
    expect(requestIdOf(null)).toBeNull();
  });

  it("uses the route template, never the page path", () => {
    const out = scrubEvent(
      hostileEvent(),
      {},
      {
        ...ctx,
        pathname: `/reset-password#token=${TOKEN}`,
      },
    );
    expect(out.tags?.route).toBe("(none)");
  });
});

describe("breadcrumbs (F-07)", () => {
  it("drops DOM, console and anything unknown", () => {
    const [click, consoleCrumb] = hostileEvent().breadcrumbs ?? [];
    expect(scrubBreadcrumb(click!, routeOf)).toBeNull();
    expect(scrubBreadcrumb(consoleCrumb!, routeOf)).toBeNull();
    expect(
      scrubBreadcrumb({ category: "sentry.event", message: TOKEN }, routeOf),
    ).toBeNull();
  });

  it("keeps fetch as method, path and status only, and navigation as route templates", () => {
    const [, , fetchCrumb, nav] = hostileEvent().breadcrumbs ?? [];
    expect(scrubBreadcrumb(fetchCrumb!, routeOf)).toEqual({
      category: "fetch",
      type: "http",
      timestamp: 1,
      data: {
        method: "GET",
        url: `/api/budgets/${USER}/transactions`,
        status_code: 500,
      },
    });
    expect(scrubBreadcrumb(nav!, routeOf)).toEqual({
      category: "navigation",
      data: { from: "(none)", to: "/budgets/:budgetId" },
    });
  });
});

describe("error message allowlist (owner ruling, round 8)", () => {
  const ctx = {
    routeOf,
    pathname: "/",
    userId: null,
    userAgent: "Mozilla/5.0 (iPhone)",
    origin: ORIGIN,
  };
  const keep = (m: string) => safeMessage(m, ctx);
  const REACT_418 =
    "Minified React error #418; visit https://react.dev/errors/418 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";
  const CHUNK = `${ORIGIN}/assets/HomeScreen-cd440ebe.js`;

  /** One or more real messages per SAFE_MESSAGES entry. */
  const ALLOWED = [
    "Unexpected response (HTTP 502)",
    "Network request failed",
    "Sign-out failed",
    "Re-authentication cancelled",
    "useAuth outside AuthProvider",
    "useMe needs a signed-in user",
    "useReauth outside ReauthProvider",
    "useToast outside ToastProvider",
    "useCurrentBudget outside BudgetLayout",
    "Money amounts must be integer cents.",
    "missing #root",
    "Script error",
    "Script error.",
    REACT_418,
    `Failed to fetch dynamically imported module: ${CHUNK}`,
    `error loading dynamically imported module: ${ORIGIN}/assets/rolldown-runtime-0123abcd.js`,
    "Importing a module script failed.",
    "Failed to fetch",
    "Load failed",
    "NetworkError when attempting to fetch resource.",
    "ResizeObserver loop completed with undelivered notifications.",
    "ResizeObserver loop limit exceeded",
  ];

  it("keeps every allowed message unchanged", () => {
    for (const m of ALLOWED) expect(keep(m), m).toBe(m);
  });

  it("covers every SAFE_MESSAGES entry with a sample", () => {
    for (const { re } of SAFE_MESSAGES)
      expect(
        ALLOWED.some((m) => re.test(m)),
        re.source,
      ).toBe(true);
  });

  it("keeps every contract error code (ApiError) and nothing else upper-case", () => {
    for (const code of Object.keys(ERROR_COPY)) expect(keep(code)).toBe(code);
    for (const m of ["PHARMACY", "ALICE_EXAMPLE", "CVS", "__proto__"])
      expect(keep(m), m).toBe(REDACTED);
  });

  it("matches what the app's own error classes actually say", () => {
    const thrown = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("did not throw");
    };
    for (const m of [
      new NetworkError().message,
      new UnexpectedResponseError(503, null).message,
      new SignOutError({ cause: null }).message,
      new ReauthCancelled().message,
      thrown(() => sumCents([0.5])),
    ])
      expect(keep(m), m).toBe(m);
  });

  const LEAKS = [
    "alice@example.test",
    "$45.00",
    "4500",
    "Pharmacy",
    "Alice Example",
    TOKEN,
    `?token=${TOKEN}`,
    "#token=" + TOKEN,
    "?month=2026-11&payee=Pharmacy",
  ];

  it("drops an allowed message with anything appended, prepended or on another line", () => {
    for (const base of ALLOWED)
      for (const leak of LEAKS)
        for (const m of [
          `${base} ${leak}`,
          `${base}${leak}`,
          `${base}: ${leak}`,
          `${leak} ${base}`,
          `${base}\n${leak}`,
          `${leak}\n${base}`,
        ])
          expect(keep(m), m).toBe(REDACTED);
  });

  it("drops near misses that embed data in a variable part", () => {
    for (const m of [
      "Unexpected response (HTTP 4500)",
      "Unexpected response (HTTP $45.00)",
      "Minified React error #418 alice@example.test; visit https://react.dev/errors/418 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.",
      "Minified React error #418; visit https://react.dev/errors/419 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.",
      "Minified React error #418; visit https://react.dev/errors/418 Pharmacy for the full message or use the non-minified dev environment for full errors and additional helpful warnings.",
      "Minified React error #418; visit https://evil.example/errors/418?args[]=Pharmacy for the full message or use the non-minified dev environment for full errors and additional helpful warnings.",
      `Failed to fetch dynamically imported module: ${CHUNK}?token=${TOKEN}`,
      `Failed to fetch dynamically imported module: ${CHUNK}#token=${TOKEN}`,
      `Failed to fetch dynamically imported module: https://evil.example/assets/HomeScreen-cd440ebe.js`,
      `Failed to fetch dynamically imported module: ${ORIGIN}.evil.example/assets/HomeScreen-cd440ebe.js`,
      `Failed to fetch dynamically imported module: ${ORIGIN}/assets/alice@example.test-cd440ebe.js`,
      `Failed to fetch dynamically imported module: ${ORIGIN}/assets/Pharmacy 45.00-cd440ebe.js`,
      `Failed to fetch dynamically imported module: ${ORIGIN}/assets/HomeScreen.js`,
      `Failed to fetch dynamically imported module: ${ORIGIN}/budgets/${USER}`,
      `Failed to fetch dynamically imported module: ${ORIGIN}/api/budgets/${USER}/transactions?payee=Pharmacy`,
      `Failed to fetch dynamically imported module: ${ORIGIN}/assets/x-cd440ebe.js/../../api/me`,
      "Failed to fetch (alice@example.test)",
      `Failed to fetch ${ORIGIN}/api/me?token=${TOKEN}`,
      "Load failed: Pharmacy",
      "Network request failed for alice@example.test",
      "Money amounts must be integer cents. Got 45.001",
      "useAuth outside AuthProvider|alice@example.test",
    ])
      expect(keep(m), m).toBe(REDACTED);
  });

  it("strips React's error-decoder args, which can carry values", () => {
    const withArgs = REACT_418.replace(
      "errors/418",
      `errors/418?args[]=alice%40example.test&args[]=Pharmacy%20%2445.00&args[]=${TOKEN}`,
    );
    expect(keep(withArgs)).toBe(REACT_418);
    expect(keep(REACT_418.replace("errors/418", "errors/418#Pharmacy"))).toBe(
      REACT_418,
    );
    expect(
      stripReactArgs(
        "see https://react.dev/errors/31?args[]=object%20with%20keys%20%7Bpayee%7D now",
      ),
    ).toBe("see https://react.dev/errors/31 now");
  });

  it("drops JSON.parse messages, which quote the input", () => {
    const parseError = (text: string) => {
      try {
        JSON.parse(text);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("parsed");
    };
    for (const m of [
      parseError("Pharmacy $45.00 alice@example.test"),
      parseError(`{"payee":"Pharmacy","amount":4500`),
      parseError(`<html>alice@example.test</html>`),
      // Safari and Firefox wording.
      'JSON Parse error: Unexpected identifier "Pharmacy"',
      "JSON.parse: unexpected character at line 1 column 1 of the JSON data",
      // React development-style messages that quote props and values.
      "Objects are not valid as a React child (found: object with keys {payee, amount}).",
      "Non-Error promise rejection captured with value: alice@example.test",
    ])
      expect(keep(m), m).toBe(REDACTED);
  });

  it("drops non-strings and empty messages", () => {
    for (const m of [undefined, null, 4500, { payee: "Pharmacy" }, ""])
      expect(safeMessage(m, ctx)).toBe(REDACTED);
  });

  /** The rule the real list must pass: every entry anchored, no free text. */
  const listProblems = (list: readonly SafeMessage[]) =>
    list.flatMap(({ re }) =>
      patternProblems(re).map((p) => `${re.source}: ${p}`),
    );

  it("has every pattern anchored ^…$ with bounded, non-free-text parts", () => {
    expect(listProblems(SAFE_MESSAGES)).toEqual([]);
  });

  it("fails that check for a list with an unanchored or free-text entry", () => {
    expect(listProblems([...SAFE_MESSAGES, { re: /Failed to fetch/ }])).toEqual(
      [
        "Failed to fetch: not anchored at the start",
        "Failed to fetch: not anchored at the end",
      ],
    );
    for (const re of [
      /^Failed to fetch/,
      /Failed to fetch$/,
      /^Failed to fetch\$/,
      /^Load failed|Failed to fetch$/,
      /^Failed to fetch.*$/,
      /^Failed to fetch .{1,20}$/,
      /^Failed to fetch [^)]{1,20}$/,
      /^Failed to fetch \S{1,20}$/,
      /^Failed to fetch \w+$/,
      /^Failed to fetch [a-z]*$/,
      /^Failed to fetch [a-z]{1,}$/,
      /^Failed to fetch$/m,
      /^Failed to fetch$/g,
      /^Failed to fetch$/s,
      /^Failed$ to fetch$/,
    ])
      expect(patternProblems(re), re.toString()).not.toEqual([]);
  });

  it("still requires a whole-string match if a pattern's anchors were lost", () => {
    const loose: SafeMessage[] = [{ re: /Failed to fetch/ }];
    expect(safeMessage("Failed to fetch", ctx, loose)).toBe("Failed to fetch");
    expect(safeMessage("Failed to fetch alice@example.test", ctx, loose)).toBe(
      REDACTED,
    );
    const multiline: SafeMessage[] = [{ re: /^Failed to fetch$/m }];
    expect(
      safeMessage("Failed to fetch\nalice@example.test", ctx, multiline),
    ).toBe(REDACTED);
  });

  it("keeps allowed messages inside a scrubbed event", () => {
    const event = hostileEvent();
    event.exception = {
      values: [
        {
          type: "Error",
          value: REACT_418.replace("errors/418", "errors/418?args[]=Pharmacy"),
        },
        {
          type: "TypeError",
          value: `Failed to fetch dynamically imported module: ${CHUNK}`,
        },
        { type: "SyntaxError", value: `"Pharmacy" is not valid JSON` },
      ],
    };
    expect(
      scrubEvent(event, {}, ctx).exception?.values?.map((v) => v.value),
    ).toEqual([
      REACT_418,
      `Failed to fetch dynamically imported module: ${CHUNK}`,
      REDACTED,
    ]);
  });
});
