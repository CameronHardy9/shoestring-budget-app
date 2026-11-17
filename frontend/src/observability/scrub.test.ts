import { defaultStackParser, type ErrorEvent } from "@sentry/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NetworkError, UnexpectedResponseError } from "../api/errors.ts";
import { ERROR_COPY } from "../api/messages.ts";
import { SignOutError } from "../app/auth.tsx";
import { ReauthCancelled } from "../app/reauth.tsx";
import { sumCents } from "../lib/splits.ts";
import {
  ANONYMOUS,
  asStackParserSees,
  EXTERNAL,
  fromMessage,
  pathOf,
  patternProblems,
  REDACTED,
  requestIdOf,
  SAFE_MESSAGES,
  safeMessage,
  scrubBreadcrumb,
  scrubEvent,
  safeFrameFile,
  safeFrameFunction,
  stripReactArgs,
  stripUrl,
  type SafeMessage,
  v8StackHeader,
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
    // An engine whose stacks don't hold the message (Firefox, Safari): no
    // header to check (F-62), so this is about the frames' own bounds.
    const [first, second] =
      scrubEvent(hostileEvent(), {}, { ...ctx, stackHeader: false }).exception
        ?.values ?? [];
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
          { filename: EXTERNAL, function: ANONYMOUS, lineno: 2 },
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

describe("stack frames (F-59)", () => {
  const ctx = {
    routeOf,
    pathname: "/",
    userId: USER,
    userAgent: "Mozilla/5.0 (iPhone)",
    origin: ORIGIN,
  };
  const INDEX = `${ORIGIN}/assets/index-1a2b3c4d.js`;
  const SHEET = `${ORIGIN}/assets/TransactionSheet-0a1b2c3d.js`;
  // Real V8 frames as a production build prints them.
  const REAL_V8 = [
    `    at Object.save (${INDEX}:1:4321)`,
    `    at async HTMLButtonElement.onclick (${SHEET}:2:99)`,
    `    at Array.map (<anonymous>)`,
    `    at new Foo (${INDEX}:1:10)`,
    `    at ${INDEX}:1:5`,
  ].join("\n");
  // Sentry's frames are oldest first.
  const REAL_FRAMES = [
    { filename: INDEX, function: ANONYMOUS, lineno: 1, colno: 5, in_app: true },
    {
      filename: INDEX,
      function: "new Foo",
      lineno: 1,
      colno: 10,
      in_app: true,
    },
    { filename: "<anonymous>", function: "Array.map", in_app: true },
    {
      filename: SHEET,
      function: "async HTMLButtonElement.onclick",
      lineno: 2,
      colno: 99,
      in_app: true,
    },
    {
      filename: INDEX,
      function: "Object.save",
      lineno: 1,
      colno: 4321,
      in_app: true,
    },
  ];
  const HOSTILE =
    "    at alice@example.test Pharmacy (https://evil.example/x.js?token=abc:1:2)";
  const HOSTILE_TEXT = [
    "alice",
    "example.test",
    "Pharmacy",
    "evil.example",
    "x.js",
    "token",
    "abc",
  ];

  /** The event Sentry builds for an error whose V8 stack is `stack`. */
  function eventFor(type: string, message: string, stack: string): ErrorEvent {
    return {
      type: undefined,
      exception: {
        values: [
          {
            type,
            value: message,
            stacktrace: { frames: defaultStackParser(stack) },
          },
        ],
      },
    };
  }
  const framesOf = (event: ErrorEvent, error: unknown) =>
    scrubEvent(event, { originalException: error }, ctx).exception?.values?.[0]
      ?.stacktrace?.frames;

  it("keeps real frames from every part of a production stack intact", () => {
    const stack = `TypeError: x is undefined\n${REAL_V8}`;
    expect(
      framesOf(eventFor("TypeError", "x is undefined", stack), {
        name: "TypeError",
        message: "x is undefined",
        stack,
      }),
    ).toEqual(REAL_FRAMES);
  });

  it("sends nothing from a frame-shaped line inside a multi-line message", () => {
    const message = `Unexpected token\n${HOSTILE}`;
    const stack = `SyntaxError: ${message}\n${REAL_V8}`;
    const event = eventFor("SyntaxError", message, stack);
    // The SDK's own parser really does turn that message line into a frame.
    expect(JSON.stringify(event)).toContain("evil.example");
    const frames = framesOf(event, new SyntaxError(message));
    const out = JSON.stringify(frames);
    for (const text of HOSTILE_TEXT) expect(out).not.toContain(text);
    expect(frames).toEqual(REAL_FRAMES);
  });

  it("does the same for a real V8 error and the SDK's parser", () => {
    const error = new Error(`Unexpected token\n${HOSTILE}`);
    const event = eventFor("Error", error.message, error.stack ?? "");
    const frames = framesOf(event, error) ?? [];
    expect(frames.length).toBeGreaterThan(0);
    const out = JSON.stringify(frames);
    for (const text of HOSTILE_TEXT) expect(out).not.toContain(text);
  });

  it("bounds the frame even if the message were truncated or lost", () => {
    // The SDK may truncate `value`; without any message to compare, the
    // file and function bounds alone still let none of it through.
    const stack = `x: y\n${HOSTILE}`;
    const event = eventFor("SyntaxError", "Unexpected", stack);
    expect(framesOf(event, { name: "x", message: "y", stack })).toEqual([
      {
        filename: EXTERNAL,
        function: ANONYMOUS,
        lineno: 1,
        colno: 2,
        in_app: true,
      },
    ]);
  });

  it("drops a one-word line that spoofs this app's own chunk (Chrome and Firefox shapes)", () => {
    for (const line of [
      `    at Pharmacy (${ORIGIN}/assets/Pharmacy-deadbeef.js:1:2)`,
      `Pharmacy@${ORIGIN}/assets/index-1a2b3c4d.js:1:2`,
      `    at Pharmacy (${INDEX}:1:2)`,
      `    at ${ORIGIN}/assets/Pharmacy-deadbeef.js:1:2`,
    ]) {
      const message = `Unexpected token\n${line}`;
      const stack = `SyntaxError: ${message}\n${REAL_V8}`;
      const frames = framesOf(
        eventFor("SyntaxError", message, stack),
        new SyntaxError(message),
      );
      expect(JSON.stringify(frames), line).not.toContain("Pharmacy");
      // A message quoting a real chunk's URL also drops that chunk's real
      // frames: over-matching loses frames, never sends message text.
      for (const f of frames ?? []) expect(REAL_FRAMES, line).toContainEqual(f);
      expect(frames, line).toContainEqual(REAL_FRAMES[3]);
    }
  });

  it("keeps Firefox and Safari frames, whose stacks never hold the message", () => {
    const message = `Unexpected token\n${HOSTILE}`;
    const stack = `save@${INDEX}:1:4321\n@${SHEET}:2:99`;
    expect(
      framesOf(
        eventFor("SyntaxError", message, stack),
        new SyntaxError(message),
      ),
    ).toEqual([
      {
        filename: SHEET,
        function: ANONYMOUS,
        lineno: 2,
        colno: 99,
        in_app: true,
      },
      {
        filename: INDEX,
        function: "save",
        lineno: 1,
        colno: 4321,
        in_app: true,
      },
    ]);
  });

  it("keeps only this origin's own hashed chunks as file names", () => {
    expect(safeFrameFile(INDEX, ctx)).toBe(INDEX);
    expect(safeFrameFile(`${INDEX}?token=${TOKEN}#token=${TOKEN}`, ctx)).toBe(
      INDEX,
    );
    for (const pseudo of ["<anonymous>", "native", "[native code]"])
      expect(safeFrameFile(pseudo, ctx)).toBe(pseudo);
    for (const other of [
      "https://evil.example/assets/index-1a2b3c4d.js",
      `${ORIGIN}/assets/x.js`,
      `${ORIGIN}/assets/index-1A2B3C4D.js`,
      `${ORIGIN}/assets/a.b-1a2b3c4d.js`,
      `${ORIGIN}/assets/index-1a2b3c4d.js.map`,
      `${ORIGIN}/src/main.tsx`,
      `${ORIGIN}/sw.js`,
      `${ORIGIN}.evil.example/assets/index-1a2b3c4d.js`,
      `${ORIGIN}/assets/index-1a2b3c4d.js Pharmacy`,
      "chrome-extension://abc/content.js",
      "<data:application/javascript,alice@example.test>",
      "alice@example.test Pharmacy",
      "",
      undefined,
      42,
    ])
      expect(safeFrameFile(other, ctx), String(other)).toBe(EXTERNAL);
  });

  it("keeps function names browsers print, and nothing with free text", () => {
    for (const name of [
      "Object.save",
      "HTMLButtonElement.onclick",
      "new Foo",
      "async Promise.all",
      "async HTMLButtonElement.onclick",
      "Object.<anonymous>",
      "<anonymous>",
      "Ue/n</<",
      "$e",
      "_.Xy$1",
      "Object.foo [as bar]",
    ])
      expect(safeFrameFunction(name), name).toBe(name);
    for (const name of [
      "?",
      "",
      "alice@example.test",
      "Pharmacy copay",
      "alice example",
      "new  Foo",
      "Foo [as Pharmacy copay]",
      "Object.save\nPharmacy",
      "x".repeat(129),
      undefined,
      7,
    ])
      expect(safeFrameFunction(name), String(name)).toBe(ANONYMOUS);
  });

  it("only drops frames when there is a multi-line message", () => {
    const frame = { filename: INDEX, function: "Object.save" };
    expect(fromMessage(frame, [])).toBe(false);
    expect(fromMessage(frame, ["nothing frame-like"])).toBe(false);
    expect(fromMessage(frame, [`at Object.save (x:1:2)`])).toBe(true);
    expect(fromMessage(frame, [`see ${INDEX}`])).toBe(true);
    expect(fromMessage({ function: "?" }, ["at ? (x:1:2)"])).toBe(false);
  });

  describe("F-62", () => {
    // Vitest installs Error.prepareStackTrace (source maps), which formats
    // the header differently ("TypeError: " for an empty message). Browsers
    // use V8's own formatting, so these tests do too.
    const v8 = Error as unknown as { prepareStackTrace?: unknown };
    let saved: unknown;
    beforeEach(() => {
      saved = v8.prepareStackTrace;
      v8.prepareStackTrace = undefined;
    });
    afterEach(() => {
      v8.prepareStackTrace = saved;
    });

    // (a) @sentry/core rewrites "(error: X)" to "X" in each line before
    // parsing it, so the frame's text is not verbatim in the message.
    const REWRITTEN = "    at Pharm(error: acy (/assets/fo)o:4500:2";
    const REWRITTEN_OWN = `    at Pharm(error: acy (${ORIGIN}/assets/index-1a2b3c4d.j)s:1:2`;

    it("compares frames against the message as the SDK's parser sees it", () => {
      expect(asStackParserSees(REWRITTEN)).toBe(
        "    at Pharmacy (/assets/foo:4500:2",
      );
      expect(asStackParserSees(`a (error: b)\n${"x".repeat(1030)}`)).toBe(
        `a b\n${"x".repeat(1024)}`,
      );
    });

    it("(a) drops a message line the parser rewrites into a frame", () => {
      for (const line of [REWRITTEN, REWRITTEN_OWN]) {
        const message = `Unexpected token\n${line}`;
        const stack = `SyntaxError: ${message}\n${REAL_V8}`;
        const event = eventFor("SyntaxError", message, stack);
        // The real parser really does build a "Pharmacy" frame from it,
        // whose text is not in the message verbatim.
        const parsed = event.exception?.values?.[0]?.stacktrace?.frames ?? [];
        const fake = parsed.find((f) => f.function === "Pharmacy");
        expect(fake, line).toBeDefined();
        expect(message, line).not.toContain("at Pharmacy ");
        expect(message, line).not.toContain(String(fake?.filename));

        const frames = framesOf(event, new SyntaxError(message));
        const out = JSON.stringify(frames);
        expect(out, line).not.toContain("Pharmacy");
        expect(out, line).not.toContain("4500");
        for (const f of frames ?? [])
          expect(REAL_FRAMES, line).toContainEqual(f);
        expect(frames, line).toContainEqual(REAL_FRAMES[3]);
      }
    });

    it("(a) does the same for a real V8 error and the SDK's parser", () => {
      const error = new Error(`Unexpected token\n${REWRITTEN}`);
      const event = eventFor("Error", error.message, error.stack ?? "");
      const frames = framesOf(event, error) ?? [];
      expect(frames.length).toBeGreaterThan(0);
      const out = JSON.stringify(frames);
      expect(out).not.toContain("Pharmacy");
      expect(out).not.toContain("4500");
    });

    // (b) V8 fixes the header at the first .stack read; a message shortened
    // afterwards leaves its old lines in the stack, where the SDK parses
    // them as frames, while the tails come from the new message.
    const shortened = (
      before = "Unexpected token in JSON\n    at Pharmacy (x.js:4500:2)",
      after = "Unexpected token",
    ) => {
      const error = new Error(before);
      // The first read fixes the header.
      expect(error.stack).toContain(before);
      error.message = after;
      return error;
    };
    const realEvent = (error: Error) =>
      eventFor(error.name, error.message, error.stack ?? "");

    it("(b) sends no frames when the message changed after .stack was read", () => {
      const error = shortened();
      const event = realEvent(error);
      expect(JSON.stringify(event)).toContain("Pharmacy");
      const out = scrubEvent(event, { originalException: error }, ctx);
      expect(out.exception?.values?.[0]?.stacktrace).toBeUndefined();
      expect(JSON.stringify(out)).not.toContain("Pharmacy");
      expect(JSON.stringify(out)).not.toContain("4500");
    });

    it("(b) does the same for a message replaced or cut mid-line", () => {
      for (const after of ["short", "", "Unexpected token in JSO"]) {
        const error = shortened(undefined, after);
        expect(framesOf(realEvent(error), error), after).toBeUndefined();
      }
    });

    it("(b) residual: a cut exactly at a line break can't be told from the stack; the frame bounds still hold", () => {
      // The stale stack then starts with the current header plus "\n", the
      // same as a genuine one, and the cut-off line is in no message. What
      // can still get through is what F-59's bounds allow: one
      // identifier-shaped function name and two integers, never a file.
      const error = shortened(
        "Unexpected token\n    at Pharmacy (x.js:4500:2)",
        "Unexpected token",
      );
      const frames = framesOf(realEvent(error), error) ?? [];
      expect(frames.length).toBeGreaterThan(0);
      expect(JSON.stringify(frames)).not.toContain("x.js");
      for (const f of frames) {
        expect(f.filename === EXTERNAL || f.filename === "<anonymous>").toBe(
          true,
        );
        expect(safeFrameFunction(f.function)).toBe(f.function);
      }
    });

    it("(b) does the same when the name changed after .stack was read", () => {
      const error = new Error("x");
      expect(error.stack).toMatch(/^Error: x\n/);
      error.name = "Renamed";
      expect(framesOf(realEvent(error), error)).toBeUndefined();
    });

    it("(b) sends no frames for any value when a linked cause's header is stale", () => {
      const cause = shortened();
      const outer = new Error("Network request failed", { cause });
      const event: ErrorEvent = {
        type: undefined,
        exception: {
          values: [cause, outer].map((e) => ({
            type: e.name,
            value: e.message,
            stacktrace: { frames: defaultStackParser(e.stack ?? "") },
          })),
        },
      };
      const out = scrubEvent(event, { originalException: outer }, ctx);
      for (const v of out.exception?.values ?? [])
        expect(v.stacktrace).toBeUndefined();
      expect(JSON.stringify(out)).not.toContain("Pharmacy");
    });

    it("(b) keeps frames for the app's errors, causes included", () => {
      class AppError extends Error {
        override name = "AppError";
      }
      for (const error of [
        new AppError("Sign-out failed"),
        new SignOutError({ cause: new NetworkError() }),
        new NetworkError({ cause: new TypeError("Failed to fetch") }),
        new UnexpectedResponseError(502, null),
        new TypeError(""),
        Object.assign(new Error("m"), { name: "" }),
      ]) {
        const chain: Error[] = [];
        for (let e: unknown = error; e instanceof Error; e = e.cause)
          chain.unshift(e);
        const event: ErrorEvent = {
          type: undefined,
          exception: {
            values: chain.map((e) => ({
              type: e.name,
              value: e.message,
              stacktrace: { frames: defaultStackParser(e.stack ?? "") },
            })),
          },
        };
        const out = scrubEvent(event, { originalException: error }, ctx);
        for (const v of out.exception?.values ?? [])
          expect(v.stacktrace?.frames?.length, error.name).toBeGreaterThan(0);
      }
    });

    it("(b) fails closed when the frames can't be tied to the thrown error", () => {
      const error = new SyntaxError("Unexpected token");
      const event = realEvent(error);
      const frames = (original: unknown, values = event) =>
        framesOf(values, original);
      expect(frames(error)?.length).toBeGreaterThan(0);
      // Nothing thrown, a string, an ErrorEvent-like wrapper or a plain
      // object whose frames came from a property we don't check.
      expect(frames(undefined)).toBeUndefined();
      expect(frames("Unexpected token")).toBeUndefined();
      expect(frames({ error })).toBeUndefined();
      // More exception values than errors reachable from the thrown one.
      const two: ErrorEvent = {
        type: undefined,
        exception: {
          values: [
            ...(event.exception?.values ?? []),
            ...(event.exception?.values ?? []),
          ],
        },
      };
      expect(frames(error, two)).toBeUndefined();
      // A stack that isn't a string, and a getter that throws.
      expect(
        frames({ name: "Error", message: "x", stack: ["Error: x"] }),
      ).toBeUndefined();
      const hostile = Object.defineProperty(new Error("x"), "cause", {
        get() {
          throw new Error("no");
        },
      });
      expect(frames(hostile)).toBeUndefined();
    });

    it("(b) checks nothing on engines whose stacks never hold the message", () => {
      const stack = `save@${INDEX}:1:4321`;
      const event = eventFor("SyntaxError", "Unexpected token", stack);
      const original = {
        name: "SyntaxError",
        message: "Unexpected token",
        stack,
      };
      expect(framesOf(event, original)).toBeUndefined();
      const out = scrubEvent(
        event,
        { originalException: original },
        { ...ctx, stackHeader: false },
      );
      expect(out.exception?.values?.[0]?.stacktrace?.frames).toEqual([
        {
          filename: INDEX,
          function: "save",
          lineno: 1,
          colno: 4321,
          in_app: true,
        },
      ]);
    });

    it("v8StackHeader builds the header the way V8 does", () => {
      for (const [name, message] of [
        ["Error", "m"],
        ["TypeError", ""],
        ["", "m"],
        ["", ""],
        ["X", "a\nb"],
      ] as const) {
        const error = new Error(message);
        error.name = name;
        expect(error.stack?.split("\n    at ")[0]).toBe(
          v8StackHeader(name, message),
        );
      }
    });
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
