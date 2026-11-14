import { DalError } from "@shoestring/db";
import { afterEach, describe, expect, it } from "vitest";
import { ORIGIN, makeHarness, me } from "../test-support/harness.ts";
import type { Harness } from "../test-support/harness.ts";

const USER = "01a1d7ab-0000-7000-8000-000000000001";
const BUDGET = "01a1d7ab-0000-7000-8000-0000000000b1";

let h: Harness;
afterEach(async () => {
  await h.close();
});

const body = (r: { body: string }) =>
  JSON.parse(r.body) as Record<string, unknown> & {
    code?: string;
    details?: { in: string; field: string; issue: string }[];
  };

describe("errors.md step 0: Host check", () => {
  it("rejects a foreign Host with 400 header.Host, before route matching", async () => {
    h = await makeHarness();
    for (const url of ["/api/me", "/api/does-not-exist"]) {
      const r = await h.req("GET", url, {
        headers: { host: "shoestring-abc.a.run.app" },
      });
      expect(r.statusCode).toBe(400);
      expect(body(r).details).toEqual([
        expect.objectContaining({
          in: "header",
          field: "Host",
          issue: "invalid_value",
        }),
      ]);
    }
  });

  it("exempts only GET /api/healthz and /api/readyz", async () => {
    h = await makeHarness({
      dal: {
        health: {
          ping: () => Promise.resolve(),
          isSchemaCurrent: () => Promise.resolve(true),
        },
        mfa: { listKeyIdsInUse: () => Promise.resolve([]) },
      },
    });
    expect(
      (
        await h.req("GET", "/api/healthz", {
          headers: { host: "probe.internal" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await h.req("GET", "/api/readyz", {
          headers: { host: "probe.internal" },
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe("unknown routes and Phase B operations", () => {
  it("answers 404 NOT_FOUND ErrorBody with the request id", async () => {
    h = await makeHarness();
    const r = await h.req("GET", "/api/nope", {
      headers: { "x-request-id": "abcdef12-req" },
    });
    expect(r.statusCode).toBe(404);
    expect(body(r)).toEqual({
      code: "NOT_FOUND",
      message: "Not found.",
      requestId: "abcdef12-req",
    });
    expect(r.headers["x-request-id"]).toBe("abcdef12-req");
  });

  it("HEAD and OPTIONS on API paths are 404 ErrorBody (errors.md \"Unknown routes\")", async () => {
    h = await makeHarness();
    for (const m of ["HEAD", "OPTIONS"] as const) {
      const r = await h.req(m, "/api/healthz");
      expect([m, r.statusCode]).toEqual([m, 404]);
    }
    expect(body(await h.req("OPTIONS", "/api/me")).code).toBe("NOT_FOUND");
  });

  it("an existing path with an undeclared method is 404 too", async () => {
    h = await makeHarness();
    expect((await h.req("PUT", "/api/me", { body: {} })).statusCode).toBe(404);
    expect((await h.req("GET", "/api/auth/login")).statusCode).toBe(404);
  });

  it("generates a UUIDv7 request id when the client's is malformed", async () => {
    h = await makeHarness();
    const r = await h.req("GET", "/api/nope", {
      headers: { "x-request-id": "bad id!" },
    });
    expect(r.headers["x-request-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(body(r).requestId).toBe(r.headers["x-request-id"]);
  });
});

describe("step 3: sessions", () => {
  it("401 UNAUTHENTICATED without a cookie, with a bad cookie, or an unknown session", async () => {
    h = await makeHarness();
    expect(body(await h.req("GET", "/api/me")).code).toBe("UNAUTHENTICATED");
    expect(
      body(
        await h.req("GET", "/api/me", {
          headers: { cookie: "__Host-ss_sid=garbage" },
        }),
      ).code,
    ).toBe("UNAUTHENTICATED");
    expect(
      body(
        await h.req("GET", "/api/me", {
          headers: { cookie: `__Host-ss_sid=${"a".repeat(43)}` },
        }),
      ).code,
    ).toBe("UNAUTHENTICATED");
  });

  it("ignores the non-prefixed cookie name when COOKIE_SECURE is on", async () => {
    h = await makeHarness();
    const s = h.sessions.add({ userId: USER });
    const r = await h.req("GET", "/api/me", {
      headers: { cookie: `ss_sid=${s.token}` },
    });
    expect(body(r).code).toBe("UNAUTHENTICATED");
  });

  it("an mfa_pending session gets 401 MFA_REQUIRED on active endpoints but its state on /auth/session", async () => {
    h = await makeHarness({
      dal: {
        mfa: {
          getMfaSummary: () =>
            Promise.resolve({
              enabled: true,
              totp: true,
              passkeyCount: 0,
              recoveryCodesRemaining: 10,
            }),
        },
      },
    });
    const s = h.sessions.add({
      userId: USER,
      status: "mfa_pending",
      reauthAt: null,
    });
    expect(body(await h.req("GET", "/api/me", { auth: s })).code).toBe(
      "MFA_REQUIRED",
    );
    const r = await h.req("GET", "/api/auth/session", { auth: s });
    expect(r.statusCode).toBe(200);
    expect(body(r)).toMatchObject({
      state: "mfa_required",
      mfaMethods: ["totp", "recovery_code"],
      csrfToken: s.csrf,
    });
  });

  it("public endpoints ignore any session cookie", async () => {
    h = await makeHarness({
      dal: { users: { getLoginCredentials: () => Promise.resolve(null) } },
    });
    const r = await h.req("POST", "/api/auth/login", {
      body: { email: "x@example.test", password: "whatever" },
      headers: { cookie: "__Host-ss_sid=garbage", "x-csrf-token": "" },
    });
    expect(body(r).code).toBe("INVALID_CREDENTIALS");
  });
});

describe("step 4: CSRF", () => {
  it("requires Origin == APP_ORIGIN on unsafe methods, public endpoints included", async () => {
    h = await makeHarness();
    const r = await h.req("POST", "/api/auth/login", {
      body: { email: "a@b.test", password: "x" },
      headers: { origin: "https://evil.test" },
    });
    expect(r.statusCode).toBe(403);
    expect(body(r).code).toBe("CSRF_FAILED");
    const nul = await h.req("POST", "/api/auth/login", {
      body: { email: "a@b.test", password: "x" },
      headers: { origin: "null" },
    });
    expect(body(nul).code).toBe("CSRF_FAILED");
  });

  it("without Origin, accepts only Sec-Fetch-Site: same-origin", async () => {
    h = await makeHarness({
      dal: { users: { getLoginCredentials: () => Promise.resolve(null) } },
    });
    const noOrigin = await h.req("POST", "/api/auth/login", {
      body: { email: "a@b.test", password: "x" },
      headers: { origin: "" },
    });
    expect(body(noOrigin).code).toBe("CSRF_FAILED");
    const cross = await h.req("POST", "/api/auth/login", {
      body: { email: "a@b.test", password: "x" },
      headers: { origin: "", "sec-fetch-site": "cross-site" },
    });
    expect(body(cross).code).toBe("CSRF_FAILED");
    const same = await h.req("POST", "/api/auth/login", {
      body: { email: "a@b.test", password: "x" },
      headers: { origin: "", "sec-fetch-site": "same-origin" },
    });
    expect(body(same).code).toBe("INVALID_CREDENTIALS");
  });

  it("requires the session's X-CSRF-Token on session endpoints", async () => {
    h = await makeHarness({
      dal: { users: { updateDisplayName: () => Promise.resolve(me(USER)) } },
    });
    const s = h.sessions.add({ userId: USER });
    expect(
      body(
        await h.req("PATCH", "/api/me", {
          auth: { ...s, csrf: "x".repeat(43) },
          body: { displayName: "A" },
        }),
      ).code,
    ).toBe("CSRF_FAILED");
    expect(
      body(
        await h.req("PATCH", "/api/me", {
          auth: s,
          body: { displayName: "A" },
          headers: { "x-csrf-token": "" },
        }),
      ).code,
    ).toBe("CSRF_FAILED");
    expect(
      (await h.req("PATCH", "/api/me", { auth: s, body: { displayName: "A" } }))
        .statusCode,
    ).toBe(200);
  });

  it("checks the session (401) before CSRF (403)", async () => {
    h = await makeHarness();
    const r = await h.req("PATCH", "/api/me", {
      body: { displayName: "A" },
      headers: { origin: "https://evil.test" },
    });
    expect(body(r).code).toBe("UNAUTHENTICATED");
  });
});

describe("step 5: pending deletion", () => {
  it("403 ACCOUNT_PENDING_DELETION except on x-pending-deletion-allowed operations", async () => {
    h = await makeHarness({
      dal: { users: { getMe: () => Promise.resolve(me(USER)) } },
    });
    const s = h.sessions.add({ userId: USER, userStatus: "pending_deletion" });
    expect(body(await h.req("GET", "/api/budgets", { auth: s })).code).toBe(
      "ACCOUNT_PENDING_DELETION",
    );
    expect(
      body(
        await h.req("PATCH", "/api/me", {
          auth: s,
          body: { displayName: "A" },
        }),
      ).code,
    ).toBe("ACCOUNT_PENDING_DELETION");
    expect((await h.req("GET", "/api/me", { auth: s })).statusCode).toBe(200);
  });
});

describe("step 6: content type, size and schema", () => {
  it("415 for a non-JSON body, 413 over 64 KiB, 400 for malformed JSON", async () => {
    h = await makeHarness();
    const s = h.sessions.add({ userId: USER });
    const text = await h.app.inject({
      method: "PATCH",
      url: "/api/me",
      headers: {
        host: "app.test",
        origin: ORIGIN,
        cookie: `__Host-ss_sid=${s.token}`,
        "x-csrf-token": s.csrf,
        "content-type": "text/plain",
      },
      payload: "x",
    });
    expect(text.statusCode).toBe(415);
    expect(body(text).code).toBe("UNSUPPORTED_MEDIA_TYPE");
    const form = await h.app.inject({
      method: "PATCH",
      url: "/api/me",
      headers: {
        host: "app.test",
        origin: ORIGIN,
        cookie: `__Host-ss_sid=${s.token}`,
        "x-csrf-token": s.csrf,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "a=b",
    });
    expect(form.statusCode).toBe(415);
    const big = await h.req("PATCH", "/api/me", {
      auth: s,
      body: { displayName: "x".repeat(70_000) },
    });
    expect(big.statusCode).toBe(413);
    expect(body(big).code).toBe("PAYLOAD_TOO_LARGE");
    const bad = await h.app.inject({
      method: "PATCH",
      url: "/api/me",
      headers: {
        host: "app.test",
        origin: ORIGIN,
        cookie: `__Host-ss_sid=${s.token}`,
        "x-csrf-token": s.csrf,
        "content-type": "application/json",
      },
      payload: "{nope",
    });
    expect(bad.statusCode).toBe(400);
    expect(body(bad).details).toEqual([
      expect.objectContaining({
        in: "body",
        field: "",
        issue: "invalid_format",
      }),
    ]);
  });

  it("rejects prototype-poisoning keys", async () => {
    h = await makeHarness();
    const s = h.sessions.add({ userId: USER });
    const r = await h.app.inject({
      method: "PATCH",
      url: "/api/me",
      headers: {
        host: "app.test",
        origin: ORIGIN,
        cookie: `__Host-ss_sid=${s.token}`,
        "x-csrf-token": s.csrf,
        "content-type": "application/json",
      },
      payload: '{"displayName":"a","__proto__":{"x":1}}',
    });
    expect(r.statusCode).toBe(400);
  });

  it("rejects unknown body fields, unknown query parameters and a body on body-less operations", async () => {
    h = await makeHarness();
    const s = h.sessions.add({ userId: USER });
    const extra = body(
      await h.req("PATCH", "/api/me", {
        auth: s,
        body: { displayName: "A", admin: true },
      }),
    );
    expect(extra.details).toEqual([
      expect.objectContaining({
        in: "body",
        field: "admin",
        issue: "unknown_field",
      }),
    ]);
    const q = body(await h.req("GET", "/api/me?debug=1", { auth: s }));
    expect(q.details).toEqual([
      expect.objectContaining({
        in: "query",
        field: "debug",
        issue: "unknown_field",
      }),
    ]);
    const b = body(
      await h.req("POST", "/api/auth/logout", { auth: s, body: { all: true } }),
    );
    expect(b.details).toEqual([
      expect.objectContaining({
        in: "body",
        field: "all",
        issue: "unknown_field",
      }),
    ]);
  });

  it("never echoes submitted values in messages", async () => {
    h = await makeHarness();
    const s = h.sessions.add({ userId: USER });
    const r = await h.req("PATCH", "/api/me", {
      auth: s,
      body: { displayName: "SECRET-VALUE\u0007" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain("SECRET-VALUE");
  });
});

describe("rate limits", () => {
  it("global: 300 requests per minute per IP, then 429 with Retry-After", async () => {
    h = await makeHarness();
    for (let i = 0; i < 300; i++)
      expect((await h.req("GET", "/api/healthz")).statusCode).toBe(200);
    const r = await h.req("GET", "/api/healthz");
    expect(r.statusCode).toBe(429);
    expect(body(r).code).toBe("RATE_LIMITED");
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    h.clock.freeze(new Date(h.clock.now().getTime() + 60_000));
    expect((await h.req("GET", "/api/healthz")).statusCode).toBe(200);
  });

  it("writes: 120 unsafe requests per minute per user", async () => {
    h = await makeHarness({
      dal: { users: { updateDisplayName: () => Promise.resolve(me(USER)) } },
    });
    const s = h.sessions.add({ userId: USER });
    for (let i = 0; i < 120; i++)
      expect(
        (
          await h.req("PATCH", "/api/me", {
            auth: s,
            body: { displayName: "A" },
          })
        ).statusCode,
      ).toBe(200);
    expect(
      body(
        await h.req("PATCH", "/api/me", {
          auth: s,
          body: { displayName: "A" },
        }),
      ).code,
    ).toBe("RATE_LIMITED");
  });
});

describe("responses", () => {
  it("sets security headers and no-store on API responses", async () => {
    h = await makeHarness();
    const r = await h.req("GET", "/api/healthz");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["strict-transport-security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("maps DalError codes to their errors.md status", async () => {
    h = await makeHarness({
      dal: {
        requireMembership: () => Promise.reject(new DalError("NOT_FOUND")),
      },
    });
    const s = h.sessions.add({ userId: USER });
    const r = await h.req("GET", `/api/budgets/${BUDGET}`, { auth: s });
    expect(r.statusCode).toBe(404);
    expect(body(r).code).toBe("NOT_FOUND");
  });

  it("maps an unreachable database to 503 UNAVAILABLE", async () => {
    h = await makeHarness({
      dal: {
        users: {
          getMe: () =>
            Promise.reject(
              Object.assign(new Error("connect ECONNREFUSED"), {
                code: "ECONNREFUSED",
              }),
            ),
        },
      },
    });
    const s = h.sessions.add({ userId: USER });
    const r = await h.req("GET", "/api/me", { auth: s });
    expect(r.statusCode).toBe(503);
    expect(body(r).code).toBe("UNAVAILABLE");
  });

  it("dev/test response validation turns a contract violation into 500 and logs only schema paths", async () => {
    h = await makeHarness({
      dal: {
        users: {
          getMe: () => Promise.resolve({ ...me(USER), email: "not-an-email" }),
        },
      },
    });
    const s = h.sessions.add({ userId: USER });
    const r = await h.req("GET", "/api/me", { auth: s });
    expect(r.statusCode).toBe(500);
    expect(body(r).code).toBe("INTERNAL");
    const line = h.logs.find((l) => l.msg === "request failed");
    expect(line?.contract).toMatchObject({ operationId: "getMe", status: 200 });
    expect(JSON.stringify(h.logs)).not.toContain("not-an-email");
  });

  it("logs one line per request with route template and opaque ids only", async () => {
    h = await makeHarness({
      dal: { users: { getMe: () => Promise.resolve(me(USER)) } },
    });
    const s = h.sessions.add({ userId: USER });
    await h.req("GET", "/api/me?x=secret", { auth: s });
    const line = h.logs.find((l) => l.msg === "request");
    expect(line).toMatchObject({
      method: "GET",
      route: "/api/me",
      userId: USER,
      requestId: expect.any(String) as unknown,
    });
    const all = JSON.stringify(h.logs);
    expect(all).not.toContain(s.token);
    expect(all).not.toContain(s.csrf);
    expect(all).not.toContain("secret");
  });
});
