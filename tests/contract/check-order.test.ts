// errors.md "Check order" (deterministic; clients rely on it). Each test sets
// up a request that fails two checks at once and asserts the EARLIER step
// answers. Step numbers are errors.md's.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTransaction, createUser } from "../support/factories.ts";
import { ApiClient, codeOf, detailsOf } from "../support/http.ts";
import { advanceClock, MINUTE, testLogin } from "../support/hooks.ts";
import { dal } from "../support/dal.ts";
import { seedWorld } from "../support/world.ts";

describe("step 0: Host must be exactly APP_ORIGIN's host", () => {
  it.each([
    ["a foreign host", "evil.example"],
    ["the right name without the port", "localhost"],
    ["the platform URL", "shoestring-abc123.a.run.app"],
  ])(
    "%s → 400 VALIDATION_FAILED (header, Host), before route, session and CSRF",
    async (_l, host) => {
      const c = new ApiClient("anonymous");
      for (const [method, path] of [
        ["GET", "/api/me"],
        ["POST", "/api/budgets"],
        ["GET", "/api/nope"],
        ["POST", "/api/auth/login"],
      ] as const) {
        const res = await c.request(method, path, {
          host,
          origin: "https://evil.example",
          body: {},
        });
        expect([res.status, codeOf(res)], res.describe).toEqual([
          400,
          "VALIDATION_FAILED",
        ]);
        expect(detailsOf(res)).toContainEqual(
          expect.objectContaining({
            in: "header",
            field: "Host",
            issue: "invalid_value",
          }),
        );
      }
    },
  );

  it("GET /healthz and /readyz are exempt (platform probes use other hosts); POST to them is not", async () => {
    const c = new ApiClient("probe");
    expect((await c.get("/healthz", { host: "10.0.0.7:8080" })).status).toBe(
      200,
    );
    expect((await c.get("/readyz", { host: "10.0.0.7:8080" })).status).toBe(
      200,
    );
    const post = await c.request("POST", "/api/healthz", {
      host: "10.0.0.7:8080",
    });
    expect([post.status, codeOf(post)]).toEqual([400, "VALIDATION_FAILED"]);
  });
});

describe("step 2: the global per-IP limit precedes the session check", () => {
  it("after 300 requests in a minute, a signed-out GET /me answers 429 (Retry-After), not 401", async () => {
    const c = new ApiClient("anonymous");
    let n = 0;
    while ((await c.get("/healthz")).status !== 429) n++;
    expect(n).toBe(300);
    const res = await c.get("/me");
    expect([res.status, codeOf(res)]).toEqual([429, "RATE_LIMITED"]);
    expect(Number(res.header("retry-after"))).toBeGreaterThanOrEqual(1);
    // The window is the app clock's minute: a minute later it is open again.
    await advanceClock(MINUTE);
    expect(codeOf(await c.get("/me"))).toBe("UNAUTHENTICATED");
  });
});

describe("steps 3-4: session, then CSRF (auth.md §3)", () => {
  it("an unsafe call to a session endpoint without a session is 401 even with a foreign Origin", async () => {
    const res = await new ApiClient("anonymous").post(
      "/budgets",
      {},
      { origin: "https://evil.example" },
    );
    expect([res.status, codeOf(res)]).toEqual([401, "UNAUTHENTICATED"]);
  });

  it("a public unsafe endpoint checks Origin: foreign → 403 CSRF_FAILED; absent with Sec-Fetch-Site same-origin → allowed", async () => {
    const c = new ApiClient("anonymous");
    const foreign = await c.post(
      "/auth/signup/preview",
      { token: "a".repeat(43) },
      { origin: "https://evil.example" },
    );
    expect([foreign.status, codeOf(foreign)]).toEqual([403, "CSRF_FAILED"]);
    const noOrigin = await c.post(
      "/auth/signup/preview",
      { token: "a".repeat(43) },
      { origin: null },
    );
    expect([noOrigin.status, codeOf(noOrigin)]).toEqual([403, "CSRF_FAILED"]);
    const crossSite = await c.post(
      "/auth/signup/preview",
      { token: "a".repeat(43) },
      { origin: null, headers: { "sec-fetch-site": "cross-site" } },
    );
    expect([crossSite.status, codeOf(crossSite)]).toEqual([403, "CSRF_FAILED"]);
    const sameOrigin = await c.post(
      "/auth/signup/preview",
      { token: "a".repeat(43) },
      { origin: null, headers: { "sec-fetch-site": "same-origin" } },
    );
    expect([sameOrigin.status, codeOf(sameOrigin)]).toEqual([
      400,
      "INVITATION_INVALID",
    ]);
  });

  it("a session-bearing unsafe call needs the session's X-CSRF-Token: missing or wrong → 403 CSRF_FAILED", async () => {
    const w = await seedWorld();
    const body = { name: "Transport", kind: "expense" };
    const path = `/budgets/${w.budget.id}/categories`;
    const missing = await w.owner.client.post(path, body, { csrf: false });
    expect([missing.status, codeOf(missing)]).toEqual([403, "CSRF_FAILED"]);
    const wrong = await w.owner.client.post(path, body, {
      csrf: w.member.client.csrfToken!,
    });
    expect([wrong.status, codeOf(wrong)]).toEqual([403, "CSRF_FAILED"]);
    expect((await w.owner.client.post(path, body)).status).toBe(201);
  });

  it("a valid X-CSRF-Token does not excuse the Origin check: foreign or cross-site → 403 CSRF_FAILED, and nothing is written", async () => {
    const w = await seedWorld();
    const path = `/budgets/${w.budget.id}/categories`;
    const body = { name: "Transport", kind: "expense" };
    const attempts = [
      { origin: "https://evil.example" },
      { origin: "http://localhost" }, // APP_ORIGIN's name without its port
      { origin: "null" }, // sandboxed iframe, file: URL
      { origin: null, headers: { "sec-fetch-site": "cross-site" } },
      { origin: null, headers: { "sec-fetch-site": "same-site" } },
      { origin: null }, // neither header
    ];
    for (const opts of attempts) {
      const res = await w.owner.client.post(path, body, opts);
      expect(
        [res.status, codeOf(res)],
        `${JSON.stringify(opts)} with the session's own token`,
      ).toEqual([403, "CSRF_FAILED"]);
    }
    const list = await w.owner.client.get<{ items: { name: string }[] }>(
      `/budgets/${w.budget.id}/categories`,
    );
    expect(list.body.items.map((c) => c.name)).not.toContain("Transport");
    // The same request from the app's own origin goes through.
    expect((await w.owner.client.post(path, body)).status).toBe(201);
  });

  it("public endpoints ignore a session cookie, so no CSRF token is needed there", async () => {
    const w = await seedWorld();
    const res = await w.owner.client.post(
      "/auth/signup/preview",
      { token: "a".repeat(43) },
      { csrf: false },
    );
    expect([res.status, codeOf(res)]).toEqual([400, "INVITATION_INVALID"]);
  });

  it("GET requests never need a CSRF token", async () => {
    const w = await seedWorld();
    expect((await w.owner.client.get("/budgets", { csrf: false })).status).toBe(
      200,
    );
  });
});

describe("steps 4-6: CSRF, then pending deletion, then 415/413 and schema", () => {
  async function pendingDeletion() {
    const user = await createUser({ prefix: "leaving" });
    await dal().users.requestAccountDeletion(user.userId);
    return testLogin(user.email, "pending-deletion");
  }

  it("a pending-deletion account without a CSRF token gets 403 CSRF_FAILED, with it 403 ACCOUNT_PENDING_DELETION", async () => {
    const c = await pendingDeletion();
    const noToken = await c.patch("/me", { displayName: "X" }, { csrf: false });
    expect([noToken.status, codeOf(noToken)]).toEqual([403, "CSRF_FAILED"]);
    const withToken = await c.patch("/me", { displayName: "X" });
    expect([withToken.status, codeOf(withToken)]).toEqual([
      403,
      "ACCOUNT_PENDING_DELETION",
    ]);
  });

  it("pending deletion is checked before the content type and the body schema", async () => {
    const c = await pendingDeletion();
    const res = await c.request("PATCH", "/me", {
      rawBody: "not json",
      contentType: "text/plain",
    });
    expect([res.status, codeOf(res)]).toEqual([
      403,
      "ACCOUNT_PENDING_DELETION",
    ]);
  });

  it("415 comes before schema validation", async () => {
    const w = await seedWorld();
    const res = await w.owner.client.request(
      "POST",
      `/budgets/${w.budget.id}/categories`,
      { rawBody: "{}", contentType: "text/plain" },
    );
    expect([res.status, codeOf(res)]).toEqual([415, "UNSUPPORTED_MEDIA_TYPE"]);
  });
});

describe("step 6 before step 8: schema validation precedes the membership check", () => {
  it("a non-member's invalid body is 400, a non-member's valid body is 404", async () => {
    const w = await seedWorld();
    const path = `/budgets/${w.budget.id}/categories`;
    const invalid = await w.outsider.client.post(path, {
      name: "",
      kind: "nope",
    });
    expect([invalid.status, codeOf(invalid)]).toEqual([
      400,
      "VALIDATION_FAILED",
    ]);
    const valid = await w.outsider.client.post(path, {
      name: "Ok",
      kind: "expense",
    });
    expect([valid.status, codeOf(valid)]).toEqual([404, "NOT_FOUND"]);
  });

  it("a malformed budget ID is 400 (path, budgetId), never a 404 lookup", async () => {
    const w = await seedWorld();
    const res = await w.owner.client.get("/budgets/not-a-uuid");
    expect([res.status, codeOf(res)]).toEqual([400, "VALIDATION_FAILED"]);
    expect(detailsOf(res)).toContainEqual(
      expect.objectContaining({ in: "path", field: "budgetId" }),
    );
  });
});

describe("step 7 before step 10: an exhausted endpoint limit answers 429 even when re-auth is stale", () => {
  it("export (10 / hour): the 11th export with stale re-auth is 429 RATE_LIMITED, not 403 REAUTH_REQUIRED", async () => {
    const w = await seedWorld();
    for (let i = 0; i < 10; i++)
      expect(
        (await w.owner.client.post("/me/export", { kind: "plans" })).status,
      ).toBe(200);
    await advanceClock(11 * MINUTE); // re-auth window closed, same hourly window
    const res = await w.owner.client.post("/me/export", { kind: "plans" });
    expect([res.status, codeOf(res)]).toEqual([429, "RATE_LIMITED"]);
    expect(Number(res.header("retry-after"))).toBeGreaterThan(0);
  });

  it("with quota left and stale re-auth the answer is 403 REAUTH_REQUIRED; those refused attempts still count (attempt-counting row)", async () => {
    const w = await seedWorld();
    await advanceClock(11 * MINUTE);
    for (let i = 0; i < 10; i++) {
      const r = await w.owner.client.post("/me/export", { kind: "plans" });
      expect([r.status, codeOf(r)]).toEqual([403, "REAUTH_REQUIRED"]);
    }
    expect(
      (
        await w.owner.client.post("/auth/reauth", {
          password: w.owner.user.password,
        })
      ).status,
    ).toBe(200);
    const res = await w.owner.client.post("/me/export", { kind: "plans" });
    expect([res.status, codeOf(res)]).toEqual([429, "RATE_LIMITED"]);
  });

  it("login (20 attempts / 15 min per IP): the 21st is 429, but an invalid body is still 400 (step 6 first)", async () => {
    const c = new ApiClient("anonymous");
    for (let i = 0; i < 20; i++) {
      const r = await c.post("/auth/login", {
        email: `nobody-${i}@example.test`,
        password: "wrong password",
      });
      expect(codeOf(r)).toBe("INVALID_CREDENTIALS");
    }
    const limited = await c.post("/auth/login", {
      email: "nobody-x@example.test",
      password: "wrong password",
    });
    expect([limited.status, codeOf(limited)]).toEqual([429, "RATE_LIMITED"]);
    const invalid = await c.post("/auth/login", { email: "not an email" });
    expect([invalid.status, codeOf(invalid)]).toEqual([
      400,
      "VALIDATION_FAILED",
    ]);
  });
});

describe("step 10 before step 11: re-auth precedes the sub-resource lookup", () => {
  it("transfer-ownership to a non-member with stale re-auth → 403 REAUTH_REQUIRED (not 404)", async () => {
    const w = await seedWorld();
    await advanceClock(11 * MINUTE);
    const res = await w.owner.client.post(
      `/budgets/${w.budget.id}/transfer-ownership`,
      { userId: w.outsider.user.userId },
    );
    expect([res.status, codeOf(res)]).toEqual([403, "REAUTH_REQUIRED"]);
  });
});

describe("step 13 before step 14: the version check precedes domain rules", () => {
  it("replacing a transaction with a stale version AND splits that do not sum → 409 VERSION_CONFLICT", async () => {
    const w = await seedWorld();
    const res = await w.owner.client.put(
      `/budgets/${w.budget.id}/transactions/${w.tx.id}`,
      {
        date: w.today,
        direction: "outflow",
        amountCents: 1_000,
        payee: null,
        memo: null,
        splits: [
          { categoryId: w.budget.categories.Groceries!, amountCents: 999 },
        ],
        version: w.tx.version + 5,
      },
    );
    expect([res.status, codeOf(res)]).toEqual([409, "VERSION_CONFLICT"]);
  });

  it("deleting a used category with a stale version → 409 VERSION_CONFLICT (not CATEGORY_IN_USE)", async () => {
    const w = await seedWorld();
    const res = await w.owner.client.delete(
      `/budgets/${w.budget.id}/categories/${w.budget.categories.Groceries!}`,
      {
        query: { version: 9 },
      },
    );
    expect([res.status, codeOf(res)]).toEqual([409, "VERSION_CONFLICT"]);
    const current = await w.owner.client.delete(
      `/budgets/${w.budget.id}/categories/${w.budget.categories.Groceries!}`,
      {
        query: { version: 1 },
      },
    );
    expect([current.status, codeOf(current)]).toEqual([409, "CATEGORY_IN_USE"]);
  });

  it("an idempotent replay (step 12) still returns the original transaction after other writes to the budget", async () => {
    const w = await seedWorld();
    const key = randomUUID();
    const body = {
      date: w.today,
      direction: "outflow",
      amountCents: 100,
      splits: [{ categoryId: w.budget.categories.Dining!, amountCents: 100 }],
    };
    const first = await w.owner.client.post<{ id: string }>(
      `/budgets/${w.budget.id}/transactions`,
      body,
      { idempotencyKey: key },
    );
    await createTransaction(w.budget.scope, {
      date: w.today,
      categoryId: w.budget.categories.Dining!,
    });
    const replay = await w.owner.client.post<{ id: string }>(
      `/budgets/${w.budget.id}/transactions`,
      body,
      { idempotencyKey: key },
    );
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);
  });
});

describe("X-Request-Id (errors.md 'Request IDs')", () => {
  it("echoes a valid incoming ID and replaces an invalid one with a generated ID", async () => {
    const c = new ApiClient("anonymous");
    const good = await c.get("/healthz", { requestId: "client-req-0001" });
    expect(good.header("x-request-id")).toBe("client-req-0001");
    for (const bad of [
      "short",
      "has spaces in it",
      "x".repeat(65),
      "semi;colon-0001",
    ]) {
      const res = await c.get("/me", { requestId: bad });
      expect(res.header("x-request-id")).not.toBe(bad);
      expect(res.header("x-request-id")).toMatch(/^[A-Za-z0-9-]{8,64}$/);
      expect((res.body as { requestId: string }).requestId).toBe(
        res.header("x-request-id"),
      );
    }
  });
});
