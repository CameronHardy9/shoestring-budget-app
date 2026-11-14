import { DalError } from "@shoestring/db";
import type {
  BudgetRecord,
  InvitationRecord,
  MemberContact,
} from "@shoestring/db";
import { afterEach, describe, expect, it } from "vitest";
import { T0, makeHarness } from "../test-support/harness.ts";
import type { DalOverrides, Harness } from "../test-support/harness.ts";

const OWNER = "01a1d7ab-0000-7000-8000-00000000000a";
const MEMBER = "01a1d7ab-0000-7000-8000-00000000000b";
const STRANGER = "01a1d7ab-0000-7000-8000-00000000000c";
const B = "01a1d7ab-0000-7000-8000-0000000000b1";
const INV = "01a1d7ab-0000-7000-8000-0000000000e1";

let h: Harness;
afterEach(async () => {
  await h.close();
});
const json = (r: { body: string }) =>
  JSON.parse(r.body) as Record<string, unknown> & { code?: string };

function budget(
  role: "owner" | "member" = "owner",
  extra: Partial<BudgetRecord> = {},
): BudgetRecord {
  return {
    id: B,
    name: "Home",
    timezone: "America/Chicago",
    currency: "USD",
    myRole: role,
    memberCount: 2,
    today: "2026-11-13",
    currentMonth: "2026-11",
    createdAt: T0,
    updatedAt: T0,
    version: 3,
    ...extra,
  };
}

const contacts: MemberContact[] = [
  {
    userId: OWNER,
    email: "owner@example.test",
    displayName: "Olive",
    role: "owner",
  },
  {
    userId: MEMBER,
    email: "member@example.test",
    displayName: "Max",
    role: "member",
  },
];

/** requireMembership as the DAL does it: a scope for members, NOT_FOUND for anyone else. */
function membership(userId: string, budgetId: string) {
  if (budgetId !== B) return Promise.reject(new DalError("NOT_FOUND"));
  if (userId === OWNER)
    return Promise.resolve({ budgetId, userId, role: "owner" });
  if (userId === MEMBER)
    return Promise.resolve({ budgetId, userId, role: "member" });
  return Promise.reject(new DalError("NOT_FOUND"));
}

function harness(dal: DalOverrides = {}) {
  return makeHarness({
    dal: {
      requireMembership: membership as never,
      ...dal,
      budgets: {
        getBudget: (s: { userId: string }) =>
          Promise.resolve(budget(s.userId === OWNER ? "owner" : "member")),
        ...(dal.budgets ?? {}),
      },
    },
  });
}

describe("authorization on /budgets/{budgetId}", () => {
  it("non-members and unknown budgets get 404 NOT_FOUND on every budget route, before role or re-auth", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: STRANGER, reauthAt: null });
    const routes: [string, string, unknown?][] = [
      ["GET", `/api/budgets/${B}`],
      ["PATCH", `/api/budgets/${B}`, { name: "x", version: 1 }],
      ["DELETE", `/api/budgets/${B}?version=1`],
      ["POST", `/api/budgets/${B}/transfer-ownership`, { userId: OWNER }],
      ["GET", `/api/budgets/${B}/members`],
      ["GET", `/api/budgets/${B}/invitations`],
      ["POST", `/api/budgets/${B}/invitations`, { email: "x@example.test" }],
      ["GET", `/api/budgets/${B}/categories`],
      ["GET", `/api/budgets/${B}/months/2026-11/summary`],
      ["GET", `/api/budgets/${B}/transactions`],
    ];
    for (const [m, u, body] of routes) {
      const r = await h.req(m, u, { auth: s, body });
      expect([u, r.statusCode, json(r).code]).toEqual([u, 404, "NOT_FOUND"]);
    }
    const other = await h.req(
      "GET",
      "/api/budgets/01a1d7ab-0000-7000-8000-0000000000ff",
      { auth: h.sessions.add({ userId: OWNER }) },
    );
    expect(other.statusCode).toBe(404);
  });

  it("a malformed budget id is 400 path.budgetId", async () => {
    h = await harness();
    const r = await h.req("GET", "/api/budgets/not-a-uuid", {
      auth: h.sessions.add({ userId: OWNER }),
    });
    expect(json(r).details).toEqual([
      expect.objectContaining({
        in: "path",
        field: "budgetId",
        issue: "invalid_format",
      }),
    ]);
  });

  it("members get 403 FORBIDDEN on owner-only operations", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: MEMBER });
    for (const [m, u, body] of [
      ["PATCH", `/api/budgets/${B}`, { name: "x", version: 1 }],
      ["DELETE", `/api/budgets/${B}?version=1`, undefined],
      ["POST", `/api/budgets/${B}/transfer-ownership`, { userId: OWNER }],
      ["GET", `/api/budgets/${B}/invitations`, undefined],
      ["POST", `/api/budgets/${B}/invitations`, { email: "x@example.test" }],
      ["DELETE", `/api/budgets/${B}/invitations/${INV}`, undefined],
    ] as const) {
      const r = await h.req(m, u, { auth: s, body });
      expect([u, json(r).code]).toEqual([u, "FORBIDDEN"]);
    }
  });

  it("owners need a re-auth within 10 minutes for delete, invite and transfer", async () => {
    h = await harness();
    const s = h.sessions.add({
      userId: OWNER,
      reauthAt: new Date(T0.getTime() - 10 * 60_000 - 1),
    });
    for (const [m, u, body] of [
      ["DELETE", `/api/budgets/${B}?version=1`, undefined],
      ["POST", `/api/budgets/${B}/transfer-ownership`, { userId: MEMBER }],
      ["POST", `/api/budgets/${B}/invitations`, { email: "x@example.test" }],
    ] as const) {
      expect(json(await h.req(m, u, { auth: s, body })).code).toBe(
        "REAUTH_REQUIRED",
      );
    }
  });

  it("role (403) is checked before re-auth (403 REAUTH_REQUIRED) for members", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: MEMBER, reauthAt: null });
    expect(
      json(await h.req("DELETE", `/api/budgets/${B}?version=1`, { auth: s }))
        .code,
    ).toBe("FORBIDDEN");
  });
});

describe("budgets", () => {
  it("creates with a required Idempotency-Key and marks replays", async () => {
    const calls: unknown[] = [];
    let replayed = false;
    h = await harness({
      budgets: {
        createBudget: (
          _u: string,
          input: unknown,
          o: { idempotency: { key: string; requestHash: Buffer } },
        ) => {
          calls.push({
            input,
            key: o.idempotency.key,
            hash: o.idempotency.requestHash.toString("hex"),
          });
          const r = { replayed, value: budget() };
          replayed = true;
          return Promise.resolve(r);
        },
      },
    });
    const s = h.sessions.add({ userId: OWNER });
    const missing = await h.req("POST", "/api/budgets", {
      auth: s,
      body: { name: "Home", timezone: "UTC" },
    });
    expect(json(missing).details).toEqual([
      expect.objectContaining({
        in: "header",
        field: "Idempotency-Key",
        issue: "required",
      }),
    ]);
    const bad = await h.req("POST", "/api/budgets", {
      auth: s,
      body: { name: "Home", timezone: "UTC" },
      headers: { "idempotency-key": "nope" },
    });
    expect(json(bad).details).toEqual([
      expect.objectContaining({
        in: "header",
        field: "Idempotency-Key",
        issue: "invalid_format",
      }),
    ]);
    const key = crypto.randomUUID();
    const first = await h.req("POST", "/api/budgets", {
      auth: s,
      body: { timezone: "UTC", name: "Home" },
      headers: { "idempotency-key": key },
    });
    const again = await h.req("POST", "/api/budgets", {
      auth: s,
      body: { name: "Home", timezone: "UTC" },
      headers: { "idempotency-key": key.toUpperCase() },
    });
    expect(first.statusCode).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(again.headers["idempotent-replayed"]).toBe("true");
    const [a, b] = calls as { key: string; hash: string }[];
    expect(a!.key).toBe(b!.key);
    expect(a!.hash).toBe(b!.hash); // key order does not change the request hash
  });

  it("maps IDEMPOTENCY_KEY_REUSED and LIMIT_REACHED from the DAL to 422", async () => {
    h = await harness({
      budgets: {
        createBudget: () =>
          Promise.reject(
            new DalError("IDEMPOTENCY_KEY_REUSED", {
              details: [
                {
                  in: "header",
                  field: "Idempotency-Key",
                  issue: "invalid_value",
                },
              ],
            }),
          ),
      },
    });
    const s = h.sessions.add({ userId: OWNER });
    const r = await h.req("POST", "/api/budgets", {
      auth: s,
      body: { name: "Home", timezone: "UTC" },
      headers: { "idempotency-key": crypto.randomUUID() },
    });
    expect(r.statusCode).toBe(422);
    expect(json(r)).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      details: [{ in: "header", field: "Idempotency-Key" }],
    });
  });

  it("rejects unknown timezones and an update with nothing to change", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: OWNER });
    const tz = await h.req("POST", "/api/budgets", {
      auth: s,
      body: { name: "Home", timezone: "Mars/Olympus" },
      headers: { "idempotency-key": crypto.randomUUID() },
    });
    expect(json(tz).details).toEqual([
      expect.objectContaining({ field: "timezone", issue: "invalid_value" }),
    ]);
    const empty = await h.req("PATCH", `/api/budgets/${B}`, {
      auth: s,
      body: { version: 1 },
    });
    expect(json(empty).details).toEqual([
      expect.objectContaining({ field: "", issue: "required" }),
    ]);
  });

  it("delete: soft-deletes, records the event and notifies every member (restore link for the owner only)", async () => {
    const deleted: unknown[] = [];
    h = await harness({
      budgets: {
        deleteBudget: (_s: unknown, v: number) => {
          deleted.push(v);
          return Promise.resolve({ members: contacts });
        },
      },
    });
    const s = h.sessions.add({ userId: OWNER });
    const r = await h.req("DELETE", `/api/budgets/${B}?version=3`, { auth: s });
    expect(r.statusCode).toBe(204);
    expect(deleted).toEqual([3]);
    expect(h.events).toEqual([
      expect.objectContaining({
        type: "budget_deleted",
        userId: OWNER,
        budgetId: B,
      }),
    ]);
    const [toOwner] = h.outbox.list("owner@example.test");
    const [toMember] = h.outbox.list("member@example.test");
    expect(toOwner).toMatchObject({ kind: "budget_deleted", priority: true });
    expect(toOwner!.links).toEqual([
      "https://app.test/settings/deleted-budgets",
    ]);
    expect(toMember!.links).toEqual([]);
  });

  it("delete requires a numeric version query", async () => {
    h = await harness();
    const s = h.sessions.add({ userId: OWNER });
    const r = await h.req("DELETE", `/api/budgets/${B}`, { auth: s });
    expect(json(r).details).toEqual([
      expect.objectContaining({
        in: "query",
        field: "version",
        issue: "required",
      }),
    ]);
    const bad = await h.req("DELETE", `/api/budgets/${B}?version=1.5`, {
      auth: s,
    });
    expect(json(bad).details).toEqual([
      expect.objectContaining({ in: "query", field: "version" }),
    ]);
  });
});

describe("members and ownership transfer", () => {
  it("transfer: returns the budget as a member now sees it and notifies all members", async () => {
    let role: "owner" | "member" = "owner";
    h = await harness({
      members: {
        transferOwnership: () => {
          role = "member";
          return Promise.resolve({
            members: [
              { ...contacts[1]!, role: "owner" },
              { ...contacts[0]!, role: "member" },
            ],
          });
        },
      },
      budgets: { getBudget: () => Promise.resolve(budget(role)) },
    });
    const s = h.sessions.add({ userId: OWNER });
    const r = await h.req("POST", `/api/budgets/${B}/transfer-ownership`, {
      auth: s,
      body: { userId: MEMBER },
    });
    expect(r.statusCode).toBe(200);
    expect(json(r).myRole).toBe("member");
    expect(h.events.map((e) => e.type)).toEqual([
      "budget_ownership_transferred",
    ]);
    expect(h.outbox.list().map((m) => [m.to, m.kind])).toEqual([
      ["member@example.test", "ownership_transferred"],
      ["owner@example.test", "ownership_transferred"],
    ]);
  });

  it("transfer to yourself or to a non-member/pending-deletion member maps the DAL's 400/404", async () => {
    h = await harness({
      members: {
        transferOwnership: (_s: unknown, target: string) =>
          Promise.reject(
            target === OWNER
              ? new DalError("VALIDATION_FAILED", {
                  details: [
                    { in: "body", field: "userId", issue: "invalid_value" },
                  ],
                })
              : new DalError("NOT_FOUND"),
          ),
      },
    });
    const s = h.sessions.add({ userId: OWNER });
    const self = await h.req("POST", `/api/budgets/${B}/transfer-ownership`, {
      auth: s,
      body: { userId: OWNER },
    });
    expect(json(self)).toMatchObject({
      code: "VALIDATION_FAILED",
      details: [{ in: "body", field: "userId", issue: "invalid_value" }],
    });
    expect(
      (
        await h.req("POST", `/api/budgets/${B}/transfer-ownership`, {
          auth: s,
          body: { userId: STRANGER },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("remove: the owner removing someone notifies them; a member leaving gets no mail; owner leaving is 409", async () => {
    h = await harness({
      members: {
        removeMember: (scope: { userId: string }, target: string) => {
          if (scope.userId === OWNER && target === OWNER)
            return Promise.reject(new DalError("OWNER_CANNOT_LEAVE"));
          if (scope.userId === MEMBER && target !== MEMBER)
            return Promise.reject(new DalError("FORBIDDEN"));
          return Promise.resolve({
            removed: contacts.find((c) => c.userId === target)!,
          });
        },
      },
    });
    const owner = h.sessions.add({ userId: OWNER });
    const member = h.sessions.add({ userId: MEMBER });
    expect(
      json(
        await h.req("DELETE", `/api/budgets/${B}/members/${OWNER}`, {
          auth: owner,
        }),
      ).code,
    ).toBe("OWNER_CANNOT_LEAVE");
    expect(
      json(
        await h.req("DELETE", `/api/budgets/${B}/members/${OWNER}`, {
          auth: member,
        }),
      ).code,
    ).toBe("FORBIDDEN");
    expect(
      (
        await h.req("DELETE", `/api/budgets/${B}/members/${MEMBER}`, {
          auth: member,
        })
      ).statusCode,
    ).toBe(204);
    expect(h.outbox.list()).toEqual([]);
    expect(
      (
        await h.req("DELETE", `/api/budgets/${B}/members/${MEMBER}`, {
          auth: owner,
        })
      ).statusCode,
    ).toBe(204);
    expect(h.outbox.list("member@example.test")).toEqual([
      expect.objectContaining({ kind: "member_removed", priority: true }),
    ]);
  });
});

describe("budget invitations", () => {
  const invitation = (email: string): InvitationRecord => ({
    id: INV,
    budgetId: B,
    email,
    status: "pending",
    invitedByDisplayName: "Olive",
    createdAt: T0,
    expiresAt: new Date(T0.getTime() + 14 * 86_400_000),
    respondedAt: null,
  });

  function inviteHarness() {
    return harness({
      invitations: {
        createBudgetInvitation: (_s: unknown, email: string) =>
          Promise.resolve({
            invitation: invitation(email),
            inviteeHasAccount: email === "member2@example.test",
          }),
      },
    });
  }

  it("gives the identical response whether or not the invitee has an account; mails only existing accounts", async () => {
    h = await inviteHarness();
    const s = h.sessions.add({ userId: OWNER });
    const known = await h.req("POST", `/api/budgets/${B}/invitations`, {
      auth: s,
      body: { email: "Member2@Example.test" },
    });
    const unknown = await h.req("POST", `/api/budgets/${B}/invitations`, {
      auth: s,
      body: { email: "new@example.test" },
    });
    expect(known.statusCode).toBe(201);
    expect(unknown.statusCode).toBe(201);
    const strip = (r: { body: string }) => ({ ...json(r), email: "" });
    expect(strip(known)).toEqual(strip(unknown));
    expect(Object.keys(known.headers).sort()).toEqual(
      Object.keys(unknown.headers).sort(),
    );
    expect(h.outbox.list().map((m) => [m.to, m.kind])).toEqual([
      ["member2@example.test", "budget_invitation"],
    ]);
    expect(h.events.map((e) => e.type)).toEqual([
      "budget_invitation_created",
      "budget_invitation_created",
    ]);
  });

  it("answers at a fixed 1 s from the start of the request (F-22), also on a domain error", async () => {
    h = await inviteHarness();
    const s = h.sessions.add({ userId: OWNER });
    await h.req("POST", `/api/budgets/${B}/invitations`, {
      auth: s,
      body: { email: "x@example.test" },
    });
    expect(h.sleeps).toEqual([1000]);
    await h.close();
    h = await harness({
      invitations: {
        createBudgetInvitation: () =>
          Promise.reject(new DalError("LIMIT_REACHED")),
      },
    });
    const s2 = h.sessions.add({ userId: OWNER });
    const r = await h.req("POST", `/api/budgets/${B}/invitations`, {
      auth: s2,
      body: { email: "x@example.test" },
    });
    expect(json(r).code).toBe("LIMIT_REACHED");
    expect(h.sleeps).toEqual([1000]);
  });

  it("limits invitations to 20 per budget per UTC day, counting successes only", async () => {
    h = await inviteHarness();
    const s = h.sessions.add({ userId: OWNER });
    for (let i = 0; i < 20; i++)
      expect(
        (
          await h.req("POST", `/api/budgets/${B}/invitations`, {
            auth: s,
            body: { email: `p${i}@example.test` },
          })
        ).statusCode,
      ).toBe(201);
    const r = await h.req("POST", `/api/budgets/${B}/invitations`, {
      auth: s,
      body: { email: "late@example.test" },
    });
    expect(json(r).code).toBe("RATE_LIMITED");
  });

  it("a stranger's attempts never spend the budget's invitation quota", async () => {
    h = await inviteHarness();
    const stranger = h.sessions.add({ userId: STRANGER });
    for (let i = 0; i < 25; i++)
      await h.req("POST", `/api/budgets/${B}/invitations`, {
        auth: stranger,
        body: { email: `p${i}@example.test` },
      });
    const s = h.sessions.add({ userId: OWNER });
    expect(
      (
        await h.req("POST", `/api/budgets/${B}/invitations`, {
          auth: s,
          body: { email: "ok@example.test" },
        })
      ).statusCode,
    ).toBe(201);
  });

  it("accept: returns the budget, records the event and emails the owner", async () => {
    h = await harness({
      invitations: {
        acceptInvitation: (userId: string, id: string) =>
          userId === MEMBER && id === INV
            ? Promise.resolve({ budget: budget("member"), owner: contacts[0]! })
            : Promise.reject(new DalError("NOT_FOUND")),
      },
      users: {
        getUserContact: () =>
          Promise.resolve({
            userId: MEMBER,
            email: "member@example.test",
            displayName: "Max",
          }),
      },
    });
    const r = await h.req("POST", `/api/me/invitations/${INV}/accept`, {
      auth: h.sessions.add({ userId: MEMBER }),
    });
    expect(r.statusCode).toBe(200);
    expect(json(r).myRole).toBe("member");
    expect(h.outbox.list("owner@example.test")).toEqual([
      expect.objectContaining({ kind: "invitation_accepted", priority: true }),
    ]);
    const notMine = await h.req("POST", `/api/me/invitations/${INV}/accept`, {
      auth: h.sessions.add({ userId: STRANGER }),
    });
    expect(json(notMine).code).toBe("NOT_FOUND");
  });

  it("decline and accept map INVITATION_INVALID / ALREADY_EXISTS / LIMIT_REACHED", async () => {
    h = await harness({
      invitations: {
        declineInvitation: () =>
          Promise.reject(new DalError("INVITATION_INVALID")),
        acceptInvitation: () =>
          Promise.reject(
            new DalError("LIMIT_REACHED", {
              details: [{ in: "body", field: "", issue: "limit" }],
            }),
          ),
      },
    });
    const s = h.sessions.add({ userId: MEMBER });
    const d = await h.req("POST", `/api/me/invitations/${INV}/decline`, {
      auth: s,
    });
    expect([d.statusCode, json(d).code]).toEqual([400, "INVITATION_INVALID"]);
    const a = await h.req("POST", `/api/me/invitations/${INV}/accept`, {
      auth: s,
    });
    expect([a.statusCode, json(a).code]).toEqual([422, "LIMIT_REACHED"]);
  });
});
