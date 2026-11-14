import { DalError } from "@shoestring/db";
import type { BudgetRecord, MemberContact } from "@shoestring/db";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../crypto/keyring.ts";
import { T0, makeHarness, me } from "../test-support/harness.ts";
import type { DalOverrides, Harness } from "../test-support/harness.ts";

const U = "01a1d7ab-0000-7000-8000-000000000001";
const OTHER = "01a1d7ab-0000-7000-8000-000000000002";
const B = "01a1d7ab-0000-7000-8000-0000000000b1";
const EMAIL = "pat@example.test";
let h: Harness;
afterEach(async () => {
  await h.close();
});
const json = (r: { body: string }) =>
  JSON.parse(r.body) as Record<string, unknown> & { code?: string };

function harness(dal: DalOverrides = {}) {
  return makeHarness({
    dal: {
      ...dal,
      users: {
        getUserContact: () =>
          Promise.resolve({ userId: U, email: EMAIL, displayName: "Pat" }),
        getMe: () => Promise.resolve({ ...me(U), email: EMAIL }),
        ...(dal.users ?? {}),
      },
    },
  });
}

describe("POST /me/password", () => {
  it("uses users.changePassword (revokes other sessions and tokens), never updatePasswordHash", async () => {
    const calls: unknown[] = [];
    h = await harness({
      users: {
        changePassword: (userId: string, hash: string, current: string) => {
          calls.push([userId, hash, current]);
          return Promise.resolve({ revokedSessions: 3 });
        },
        updatePasswordHash: () =>
          Promise.reject(new Error("must not be used for a password change")),
      },
    });
    const s = h.sessions.add({ userId: U });
    expect(
      (
        await h.req("POST", "/api/me/password", {
          auth: s,
          body: { newPassword: "another long passphrase" },
        })
      ).statusCode,
    ).toBe(204);
    expect(calls).toEqual([[U, "h:another long passphrase", s.session.id]]);
    expect(h.events.map((e) => e.type)).toEqual(["password_changed"]);
    expect(h.outbox.list(EMAIL)).toEqual([
      expect.objectContaining({ kind: "password_changed", priority: true }),
    ]);
  });

  it("requires re-auth and enforces the policy", async () => {
    h = await harness();
    const stale = h.sessions.add({ userId: U, reauthAt: null });
    expect(
      json(
        await h.req("POST", "/api/me/password", {
          auth: stale,
          body: { newPassword: "another long passphrase" },
        }),
      ).code,
    ).toBe("REAUTH_REQUIRED");
    const s = h.sessions.add({ userId: U });
    expect(json(await h.req("POST", "/api/me/password", { auth: s, body: { newPassword: "too short" } })).details).toEqual([
      expect.objectContaining({ field: "newPassword", issue: "too_short" }),
    ]);
  });
});

describe("/me/sessions", () => {
  it("lists active sessions with the current one marked", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: U });
    h.sessions.add({ userId: U });
    h.sessions.add({ userId: OTHER });
    const items = json(await h.req("GET", "/api/me/sessions", { auth: s }))
      .items as { id: string; current: boolean }[];
    expect(items).toHaveLength(2);
    expect(items.filter((i) => i.current).map((i) => i.id)).toEqual([
      s.session.id,
    ]);
  });

  it("revokes only the caller's sessions (others' are 404); revoking the current one clears the cookie", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: U });
    const mine = h.sessions.add({ userId: U });
    const theirs = h.sessions.add({ userId: OTHER });
    expect(
      json(
        await h.req("DELETE", `/api/me/sessions/${theirs.session.id}`, {
          auth: s,
        }),
      ).code,
    ).toBe("NOT_FOUND");
    expect(h.sessions.rows.has(sha256(theirs.token).toString("hex"))).toBe(
      true,
    );
    const r = await h.req("DELETE", `/api/me/sessions/${mine.session.id}`, {
      auth: s,
    });
    expect([r.statusCode, r.headers["set-cookie"]]).toEqual([204, undefined]);
    const self = await h.req("DELETE", `/api/me/sessions/${s.session.id}`, {
      auth: s,
    });
    expect(String(self.headers["set-cookie"])).toContain("Max-Age=0");
  });

  it("revoke-others keeps the current session", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: U });
    h.sessions.add({ userId: U });
    expect(
      (await h.req("POST", "/api/me/sessions/revoke-others", { auth: s }))
        .statusCode,
    ).toBe(204);
    expect([...h.sessions.rows.values()].map((v) => v.session.id)).toEqual([
      s.session.id,
    ]);
    expect(h.events.map((e) => e.type)).toEqual(["sessions_revoked_others"]);
  });
});

describe("POST /me/export", () => {
  it("returns the DAL's CSV as an attachment, re-auth required, 10 per hour", async () => {
    h = await harness({
      exports: {
        exportTransactionsCsv: () =>
          Promise.resolve("budget_name\r\n'=SUM(1)\r\n"),
        exportPlansCsv: () => Promise.resolve("p\r\n"),
      },
    });
    const s = h.sessions.add({ userId: U });
    const r = await h.req("POST", "/api/me/export", {
      auth: s,
      body: { kind: "transactions" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(r.headers["content-disposition"]).toBe(
      'attachment; filename="shoestring-transactions-2026-11-13.csv"',
    );
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toBe("budget_name\r\n'=SUM(1)\r\n");
    expect(h.events.map((e) => e.type)).toEqual(["data_exported"]);
    expect(JSON.stringify(h.logs)).not.toContain("SUM");
    const stale = h.sessions.add({ userId: U, reauthAt: null });
    expect(
      json(
        await h.req("POST", "/api/me/export", {
          auth: stale,
          body: { kind: "plans" },
        }),
      ).code,
    ).toBe("REAUTH_REQUIRED");
    for (let i = 0; i < 9; i++)
      await h.req("POST", "/api/me/export", {
        auth: s,
        body: { kind: "plans" },
      });
    expect(
      json(
        await h.req("POST", "/api/me/export", {
          auth: s,
          body: { kind: "plans" },
        }),
      ).code,
    ).toBe("RATE_LIMITED");
  });
});

describe("/me/deletion (30-day grace)", () => {
  it("409 OWNS_SHARED_BUDGET while owning a shared budget", async () => {
    h = await harness({
      users: {
        requestAccountDeletion: () =>
          Promise.reject(new DalError("OWNS_SHARED_BUDGET")),
      },
    });
    const r = await h.req("POST", "/api/me/deletion", {
      auth: h.sessions.add({ userId: U }),
    });
    expect([r.statusCode, json(r).code]).toEqual([409, "OWNS_SHARED_BUDGET"]);
  });

  it("202 with the dates, cookie cleared, scheduled notice; then only allowed endpoints work", async () => {
    const purgeAfter = new Date(T0.getTime() + 30 * 86_400_000);
    h = await harness({
      users: {
        requestAccountDeletion: () =>
          Promise.resolve({
            requestedAt: T0,
            purgeAfter,
            revokedInvitations: 0,
            revokedSessions: 1,
          }),
        cancelAccountDeletion: () => Promise.resolve(),
      },
    });
    const r = await h.req("POST", "/api/me/deletion", {
      auth: h.sessions.add({ userId: U }),
    });
    expect(r.statusCode).toBe(202);
    expect(json(r)).toEqual({
      requestedAt: T0.toISOString(),
      purgeAfter: purgeAfter.toISOString(),
    });
    expect(String(r.headers["set-cookie"])).toContain("Max-Age=0");
    expect(h.outbox.list(EMAIL)[0]).toMatchObject({
      kind: "account_deletion_scheduled",
      priority: true,
    });
    expect(h.outbox.list(EMAIL)[0]!.subject).toContain("deleted");
    // Signed in again while pending deletion:
    const pd = h.sessions.add({ userId: U, userStatus: "pending_deletion" });
    expect(
      json(await h.req("GET", "/api/me/sessions", { auth: pd })).code,
    ).toBe("ACCOUNT_PENDING_DELETION");
    expect(
      json(await h.req("POST", "/api/me/deletion", { auth: pd })).code,
    ).toBe("ACCOUNT_PENDING_DELETION");
    const cancel = await h.req("DELETE", "/api/me/deletion", { auth: pd });
    expect(cancel.statusCode).toBe(200);
    expect(h.outbox.list(EMAIL).map((m) => m.kind)).toContain(
      "account_deletion_cancelled",
    );
  });

  it("DELETE with nothing pending is 404", async () => {
    h = await harness({
      users: {
        cancelAccountDeletion: () => Promise.reject(new DalError("NOT_FOUND")),
      },
    });
    expect(
      json(
        await h.req("DELETE", "/api/me/deletion", {
          auth: h.sessions.add({ userId: U }),
        }),
      ).code,
    ).toBe("NOT_FOUND");
  });
});

describe("deleted budgets (ADR-0010, F-36, F-37)", () => {
  const budget: BudgetRecord = {
    id: B,
    name: "Home",
    timezone: "UTC",
    currency: "USD",
    myRole: "owner",
    memberCount: 2,
    today: "2026-11-13",
    currentMonth: "2026-11",
    createdAt: T0,
    updatedAt: T0,
    version: 4,
  };
  const members: MemberContact[] = [
    { userId: U, email: EMAIL, displayName: "Pat", role: "owner" },
    {
      userId: OTHER,
      email: "max@example.test",
      displayName: "Max",
      role: "member",
    },
  ];

  it("lists the caller's deleted budgets", async () => {
    h = await harness({
      budgets: {
        listDeletedBudgets: () =>
          Promise.resolve([
            {
              id: B,
              name: "Home",
              deletedAt: T0,
              restorableUntil: new Date(T0.getTime() + 30 * 86_400_000),
              memberCount: 2,
            },
          ]),
      },
    });
    const r = json(
      await h.req("GET", "/api/me/deleted-budgets", {
        auth: h.sessions.add({ userId: U }),
      }),
    );
    expect(r.items).toEqual([
      {
        id: B,
        name: "Home",
        deletedAt: T0.toISOString(),
        restorableUntil: "2026-12-13T15:00:00.000Z",
        memberCount: 2,
      },
    ]);
  });

  it("restore goes through requireDeletedBudgetOwnership: anyone else is 404; success notifies all members", async () => {
    const scopes: unknown[] = [];
    h = await harness({
      requireDeletedBudgetOwnership: ((userId: string, id: string) =>
        userId === U && id === B
          ? Promise.resolve({ budgetId: id, userId, deletedAt: T0 })
          : Promise.reject(new DalError("NOT_FOUND"))) as never,
      budgets: {
        restoreDeletedBudget: (scope: unknown) => {
          scopes.push(scope);
          return Promise.resolve({ budget, members });
        },
      },
    });
    expect(
      json(
        await h.req("POST", `/api/me/deleted-budgets/${B}/restore`, {
          auth: h.sessions.add({ userId: OTHER }),
        }),
      ).code,
    ).toBe("NOT_FOUND");
    expect(scopes).toEqual([]);
    const r = await h.req("POST", `/api/me/deleted-budgets/${B}/restore`, {
      auth: h.sessions.add({ userId: U }),
    });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toMatchObject({ id: B, myRole: "owner" });
    expect(scopes).toEqual([{ budgetId: B, userId: U, deletedAt: T0 }]);
    expect(h.events.map((e) => e.type)).toEqual(["budget_restored"]);
    expect(h.outbox.list().map((m) => [m.to, m.kind])).toEqual([
      [EMAIL, "budget_restored"],
      ["max@example.test", "budget_restored"],
    ]);
  });

  it("restore at the 10-budget limit is 422 LIMIT_REACHED", async () => {
    h = await harness({
      requireDeletedBudgetOwnership: ((userId: string, id: string) =>
        Promise.resolve({ budgetId: id, userId, deletedAt: T0 })) as never,
      budgets: {
        restoreDeletedBudget: () =>
          Promise.reject(
            new DalError("LIMIT_REACHED", {
              details: [{ in: "body", field: "", issue: "limit" }],
            }),
          ),
      },
    });
    const r = await h.req("POST", `/api/me/deleted-budgets/${B}/restore`, {
      auth: h.sessions.add({ userId: U }),
    });
    expect([r.statusCode, json(r).code]).toEqual([422, "LIMIT_REACHED"]);
    expect(h.outbox.list()).toEqual([]);
  });
});
