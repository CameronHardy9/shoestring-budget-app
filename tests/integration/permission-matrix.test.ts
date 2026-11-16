// Permission matrix (auth.md §12-13, F-18, F-36, checklist C8.4, C8.9),
// GENERATED from the contract: every operation whose x-budget-role is member or
// owner, crossed with every kind of caller. Expected answers come only from the
// x- extensions (x-budget-role, x-reauth, x-session, x-pending-deletion-allowed)
// and auth.md §13; the known-good request for each operation comes from
// support/recipes.ts. A non-member always gets 404, never 403, so a budget's
// existence is not revealed.
import { describe, expect, it } from "vitest";
import { createUserWithTotp, startMfaSignIn } from "../support/auth.ts";
import { operations } from "../support/contract.ts";
import type { Operation } from "../support/contract.ts";
import { createBudget } from "../support/factories.ts";
import { ApiClient, codeOf } from "../support/http.ts";
import type { ApiResponse } from "../support/http.ts";
import { advanceClock, DAY, dal, MINUTE, testLogin } from "../support/hooks.ts";
import { invoke, RECIPES } from "../support/recipes.ts";
import type { World } from "../support/world.ts";
import { persona, seedWorld } from "../support/world.ts";

const budgetOps = operations.filter(
  (o) => o.budgetRole === "member" || o.budgetRole === "owner",
);
const rows = budgetOps.map((o) => [o.operationId, o] as const);

function expectAnswer(res: ApiResponse, status: number, code?: string): void {
  const got = [res.status, codeOf(res)];
  expect(got, `${res.describe} ${res.text.slice(0, 200)}`).toEqual([
    status,
    code,
  ]);
}

async function call(
  op: Operation,
  w: World,
  client: ApiClient,
): Promise<ApiResponse> {
  const prepared = await RECIPES[op.operationId]!.prepare(w, w.owner);
  return invoke(op.operationId, { ...prepared, client }, client);
}

describe("the matrix covers every budget-scoped operation", () => {
  it("every path with {budgetId} declares member or owner (F-18 startup rule, checked from the contract side)", () => {
    for (const op of operations.filter((o) => o.path.includes("{budgetId}")))
      expect(["member", "owner"], op.operationId).toContain(op.budgetRole);
    for (const op of operations.filter((o) =>
      o.path.includes("{deletedBudgetId}"),
    ))
      expect(op.budgetRole, op.operationId).toBe("deleted_budget_owner");
    expect(budgetOps.length).toBeGreaterThanOrEqual(20);
  });
});

describe("budget-scoped operation × caller (auth.md §13)", () => {
  it.each(rows)("%s × signed out → 401 UNAUTHENTICATED", async (_id, op) => {
    const w = await seedWorld();
    expectAnswer(
      await call(op, w, new ApiClient("anonymous")),
      401,
      "UNAUTHENTICATED",
    );
  });

  it.each(rows)(
    "%s × MFA-pending session of a member → 401 MFA_REQUIRED",
    async (_id, op) => {
      const w = await seedWorld();
      const mfa = await createUserWithTotp({ prefix: "mfa-member" });
      await dal()
        .invitations.createBudgetInvitation(w.budget.scope, mfa.email)
        .then(({ invitation }) =>
          dal().invitations.acceptInvitation(mfa.userId, invitation.id),
        );
      expectAnswer(
        await call(op, w, await startMfaSignIn(mfa)),
        401,
        "MFA_REQUIRED",
      );
    },
  );

  it.each(rows)(
    "%s × signed-in non-member → 404 NOT_FOUND (F-18)",
    async (_id, op) => {
      const w = await seedWorld();
      expectAnswer(await call(op, w, w.outsider.client), 404, "NOT_FOUND");
    },
  );

  it.each(rows)(
    "%s × former member (removed) → 404 NOT_FOUND",
    async (_id, op) => {
      const w = await seedWorld();
      await dal().members.removeMember(w.budget.scope, w.member.user.userId);
      expectAnswer(await call(op, w, w.member.client), 404, "NOT_FOUND");
    },
  );

  it.each(rows)(
    "%s × member pending account deletion → 403 ACCOUNT_PENDING_DELETION",
    async (_id, op) => {
      const w = await seedWorld();
      await dal().users.requestAccountDeletion(w.member.user.userId);
      const pd = await testLogin(w.member.user.email, "pending-deletion");
      expectAnswer(await call(op, w, pd), 403, "ACCOUNT_PENDING_DELETION");
    },
  );

  it.each(rows)(
    "%s × member → allowed for member operations, 403 FORBIDDEN for owner operations",
    async (_id, op) => {
      const w = await seedWorld();
      const res = await call(op, w, w.member.client);
      if (op.budgetRole === "owner") expectAnswer(res, 403, "FORBIDDEN");
      else expectAnswer(res, RECIPES[op.operationId]!.status);
    },
  );

  it.each(rows)("%s × owner → allowed", async (_id, op) => {
    const w = await seedWorld();
    expectAnswer(
      await call(op, w, w.owner.client),
      RECIPES[op.operationId]!.status,
    );
  });

  it.each(rows)(
    "%s × owner of a soft-deleted budget → 404 NOT_FOUND (F-36)",
    async (_id, op) => {
      const w = await seedWorld();
      const prepared = await RECIPES[op.operationId]!.prepare(w, w.owner);
      await dal().budgets.deleteBudget(w.budget.scope, w.budget.record.version);
      expectAnswer(
        await invoke(op.operationId, prepared, w.owner.client),
        404,
        "NOT_FOUND",
      );
    },
  );

  const reauthRows = rows.filter(([, o]) => o.reauth);
  it.each(reauthRows)(
    "%s × owner with re-auth older than 10 minutes → 403 REAUTH_REQUIRED",
    async (_id, op) => {
      const w = await seedWorld();
      await advanceClock(10 * MINUTE + 1_000);
      expectAnswer(await call(op, w, w.owner.client), 403, "REAUTH_REQUIRED");
    },
  );

  it.each(reauthRows.filter(([, o]) => o.budgetRole === "owner"))(
    "%s × member with stale re-auth → 403 FORBIDDEN (role, step 9, before re-auth, step 10)",
    async (_id, op) => {
      const w = await seedWorld();
      await advanceClock(10 * MINUTE + 1_000);
      expectAnswer(await call(op, w, w.member.client), 403, "FORBIDDEN");
    },
  );
});

describe("removeMember: self only for members (auth.md §13)", () => {
  it("a member cannot remove the owner or another member (403 FORBIDDEN)", async () => {
    const w = await seedWorld();
    const second = await persona("second");
    await dal()
      .invitations.createBudgetInvitation(w.budget.scope, second.user.email)
      .then(({ invitation }) =>
        dal().invitations.acceptInvitation(second.user.userId, invitation.id),
      );
    for (const target of [w.owner.user.userId, second.user.userId]) {
      const res = await w.member.client.delete(
        `/budgets/${w.budget.id}/members/${target}`,
      );
      expectAnswer(res, 403, "FORBIDDEN");
    }
  });

  it("the owner cannot remove themself (409 OWNER_CANNOT_LEAVE)", async () => {
    const w = await seedWorld();
    expectAnswer(
      await w.owner.client.delete(
        `/budgets/${w.budget.id}/members/${w.owner.user.userId}`,
      ),
      409,
      "OWNER_CANNOT_LEAVE",
    );
  });

  it("removing a user who is not a member is 404 NOT_FOUND", async () => {
    const w = await seedWorld();
    expectAnswer(
      await w.owner.client.delete(
        `/budgets/${w.budget.id}/members/${w.outsider.user.userId}`,
      ),
      404,
      "NOT_FOUND",
    );
  });
});

describe("deleted-budget routes (F-36, checklist C8.9)", () => {
  async function deletedWorld() {
    const w = await seedWorld();
    const former = await persona("former");
    await dal()
      .invitations.createBudgetInvitation(w.budget.scope, former.user.email)
      .then(({ invitation }) =>
        dal().invitations.acceptInvitation(former.user.userId, invitation.id),
      );
    await dal().members.removeMember(w.budget.scope, former.user.userId);
    await dal().budgets.deleteBudget(w.budget.scope, w.budget.record.version);
    const restore = (c: ApiClient) =>
      c.post(`/me/deleted-budgets/${w.budget.id}/restore`);
    return { w, former, restore };
  }

  it("the owner restores within 30 days (200, the budget is back for every member)", async () => {
    const { w, restore } = await deletedWorld();
    await advanceClock(29 * DAY);
    const res = await restore(w.owner.client);
    expectAnswer(res, 200);
    expect((await w.member.client.get(`/budgets/${w.budget.id}`)).status).toBe(
      200,
    );
  });

  it.each([
    ["another user", "outsider"],
    ["a current member who is not the owner", "member"],
    ["a former member", "former"],
  ] as const)("restore by %s → 404 NOT_FOUND", async (_label, who) => {
    const { w, former, restore } = await deletedWorld();
    const client = who === "former" ? former.client : w[who].client;
    expectAnswer(await restore(client), 404, "NOT_FOUND");
  });

  it("restore by the owner after the 30-day window → 404 NOT_FOUND", async () => {
    const { w, restore } = await deletedWorld();
    await advanceClock(30 * DAY + MINUTE);
    // The old session has expired by now (30-day sliding expiry): sign in again.
    const owner = await testLogin(w.owner.user.email, "owner-later");
    expectAnswer(await restore(owner), 404, "NOT_FOUND");
  });

  it("restore of a budget that is not deleted → 404 NOT_FOUND", async () => {
    const w = await seedWorld();
    expectAnswer(
      await w.owner.client.post(`/me/deleted-budgets/${w.budget.id}/restore`),
      404,
      "NOT_FOUND",
    );
  });

  it("restore while signed out → 401 UNAUTHENTICATED", async () => {
    const { restore } = await deletedWorld();
    expectAnswer(
      await restore(new ApiClient("anonymous")),
      401,
      "UNAUTHENTICATED",
    );
  });

  it("GET /me/deleted-budgets lists the budget only for its owner", async () => {
    const { w, former } = await deletedWorld();
    const ids = async (c: ApiClient) =>
      (
        await c.get<{ items: { id: string }[] }>("/me/deleted-budgets")
      ).body.items.map((i) => i.id);
    expect(await ids(w.owner.client)).toEqual([w.budget.id]);
    expect(await ids(w.member.client)).toEqual([]);
    expect(await ids(former.client)).toEqual([]);
    expect(await ids(w.outsider.client)).toEqual([]);
  });

  it("the outsider's own deleted budget is not restorable by the world's owner", async () => {
    const w = await seedWorld();
    const theirs = await createBudget(w.outsider.user, { name: "Theirs" });
    await dal().budgets.deleteBudget(theirs.scope, theirs.record.version);
    expectAnswer(
      await w.owner.client.post(`/me/deleted-budgets/${theirs.id}/restore`),
      404,
      "NOT_FOUND",
    );
  });
});
