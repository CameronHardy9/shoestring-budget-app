import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DAY_MS } from "../context.ts";
import {
  addMember,
  expectDalError,
  expectPgError,
  gate,
  hash32,
  newBudget,
  newUser,
  uniqueEmail,
  waitForLockWaiters,
} from "../test-support/fixtures.ts";
import { START, useTestDb } from "../test-support/harness.ts";

const t = useTestDb();

describe("createBudget", () => {
  it("creates the budget, owner membership, starter categories and this month's plan atomically", async () => {
    const { userId } = await newUser(t.dal);
    const { value: budget } = await t.dal.budgets.createBudget(userId, {
      name: "Home",
      timezone: "America/Los_Angeles",
      categories: [
        { name: "Rent", kind: "expense", plannedCents: 150_000 },
        { name: "Fun", kind: "expense" },
      ],
    });
    expect(budget).toMatchObject({
      name: "Home",
      currency: "USD",
      myRole: "owner",
      memberCount: 1,
      version: 1,
      today: "2026-11-13",
      currentMonth: "2026-11",
    });
    const scope = await t.dal.requireMembership(userId, budget.id);
    const plan = await t.dal.plans.getMonthPlan(scope, "2026-11");
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      amountCents: 150_000,
      updatedByUserId: userId,
      version: 1,
    });
  });

  it("refuses duplicate starter names and rolls back fully", async () => {
    const { userId } = await newUser(t.dal);
    await expectDalError(
      t.dal.budgets.createBudget(userId, {
        name: "X",
        timezone: "UTC",
        categories: [
          { name: "Food", kind: "expense" },
          { name: "food", kind: "expense" },
        ],
      }),
      "VALIDATION_FAILED",
    );
    expect(await t.dal.budgets.listBudgetsForUser(userId)).toEqual([]);
  });

  it("stops at 10 non-deleted budgets; soft-deleted ones do not count", async () => {
    const { userId } = await newUser(t.dal);
    const made = [];
    for (let i = 0; i < 10; i++)
      made.push(
        (
          await t.dal.budgets.createBudget(userId, {
            name: `B${i}`,
            timezone: "UTC",
          })
        ).value,
      );
    await expectDalError(
      t.dal.budgets.createBudget(userId, { name: "B10", timezone: "UTC" }),
      "LIMIT_REACHED",
    );
    const first = made[0]!;
    await t.dal.budgets.deleteBudget(
      await t.dal.requireMembership(userId, first.id),
      first.version,
    );
    const eleventh = await t.dal.budgets.createBudget(userId, {
      name: "B10",
      timezone: "UTC",
    });
    expect(eleventh.replayed).toBe(false);
    // Restore is refused while the owner is at 10.
    const ds = await t.dal.requireDeletedBudgetOwnership(userId, first.id);
    await expectDalError(
      t.dal.budgets.restoreDeletedBudget(ds),
      "LIMIT_REACHED",
    );
  });

  it("serializes concurrent creates against the limit", async () => {
    const { userId } = await newUser(t.dal);
    for (let i = 0; i < 8; i++)
      await t.dal.budgets.createBudget(userId, {
        name: `C${i}`,
        timezone: "UTC",
      });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        t.dal.budgets.createBudget(userId, {
          name: `Race${i}`,
          timezone: "UTC",
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect((await t.dal.budgets.listBudgetsForUser(userId)).length).toBe(10);
  });

  it("replays an idempotent create through the membership check", async () => {
    const { userId } = await newUser(t.dal);
    const idem = { userId, key: randomUUID(), requestHash: hash32() };
    const a = await t.dal.budgets.createBudget(
      userId,
      { name: "Once", timezone: "UTC" },
      { idempotency: idem },
    );
    const b = await t.dal.budgets.createBudget(
      userId,
      { name: "Once", timezone: "UTC" },
      { idempotency: idem },
    );
    expect(b).toMatchObject({ replayed: true, value: { id: a.value.id } });
    await t.dal.budgets.deleteBudget(
      await t.dal.requireMembership(userId, a.value.id),
      a.value.version,
    );
    await expectDalError(
      t.dal.budgets.createBudget(
        userId,
        { name: "Once", timezone: "UTC" },
        { idempotency: idem },
      ),
      "NOT_FOUND",
    );
  });
});

describe("owner actions, deletion and restore", () => {
  it("lets only the owner rename, with optimistic versions", async () => {
    const owner = await newUser(t.dal);
    const member = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId);
    const ms = await addMember(t.dal, f.scope, member);
    await expectDalError(
      t.dal.budgets.updateBudget(ms, { name: "Mine now", version: 1 }),
      "FORBIDDEN",
    );
    const renamed = await t.dal.budgets.updateBudget(f.scope, {
      name: "Renamed",
      timezone: "Europe/London",
      version: 1,
    });
    expect(renamed).toMatchObject({
      name: "Renamed",
      timezone: "Europe/London",
      version: 2,
      memberCount: 2,
    });
    await expectDalError(
      t.dal.budgets.updateBudget(f.scope, { name: "Stale", version: 1 }),
      "VERSION_CONFLICT",
    );
  });

  it("soft-deletes for everyone and restores within 30 days, then not after", async () => {
    const owner = await newUser(t.dal);
    const member = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId);
    await addMember(t.dal, f.scope, member);
    const { members } = await t.dal.budgets.deleteBudget(f.scope, 1);
    expect(members.map((m) => m.role).sort()).toEqual(["member", "owner"]);
    await expectDalError(
      t.dal.requireMembership(member.userId, f.budget.id),
      "NOT_FOUND",
    );
    expect(await t.dal.budgets.listBudgetsForUser(member.userId)).toEqual([]);

    const listed = await t.dal.budgets.listDeletedBudgets(owner.userId);
    expect(listed[0]).toMatchObject({ id: f.budget.id, memberCount: 2 });
    expect(await t.dal.budgets.listDeletedBudgets(member.userId)).toEqual([]);
    await expectDalError(
      t.dal.requireDeletedBudgetOwnership(member.userId, f.budget.id),
      "NOT_FOUND",
    );

    const ds = await t.dal.requireDeletedBudgetOwnership(
      owner.userId,
      f.budget.id,
    );
    const restored = await t.dal.budgets.restoreDeletedBudget(ds);
    expect(restored.budget).toMatchObject({
      id: f.budget.id,
      version: 3,
      memberCount: 2,
    });
    expect(restored.members).toHaveLength(2);
    await t.dal.requireMembership(member.userId, f.budget.id);

    await t.dal.budgets.deleteBudget(f.scope, 3);
    t.clock.advance(30 * DAY_MS + 1000);
    await expectDalError(
      t.dal.requireDeletedBudgetOwnership(owner.userId, f.budget.id),
      "NOT_FOUND",
    );
    expect(await t.dal.budgets.listDeletedBudgets(owner.userId)).toEqual([]);
    t.clock.set(START);
  });

  it("refuses a restore that would push another member past the hard bound of 20", async () => {
    const owner = await newUser(t.dal);
    const member = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId);
    await addMember(t.dal, f.scope, member);
    await t.dal.budgets.deleteBudget(f.scope, 1);
    // Put the member into 20 live budgets directly (only restores can do this in the app).
    for (let i = 0; i < 20; i++) {
      const id = randomUUID();
      await t.admin.query("begin");
      await t.admin.query(
        "insert into budgets (id, name, timezone, created_at, updated_at) values ($1, 'Filler', 'UTC', now(), now())",
        [id],
      );
      await t.admin.query(
        "insert into budget_members values ($1, $2, 'owner', now(), now(), now())",
        [id, member.userId],
      );
      await t.admin.query("commit");
    }
    await expectDalError(
      t.dal.budgets.restoreDeletedBudget(
        await t.dal.requireDeletedBudgetOwnership(owner.userId, f.budget.id),
      ),
      "LIMIT_REACHED",
    );
  });

  it("enforces exactly one owner per non-deleted budget at commit", async () => {
    const owner = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId);
    await expectPgError(
      t.app.query("delete from budget_members where budget_id = $1", [
        f.budget.id,
      ]),
      "23514",
    );
    const second = await newUser(t.dal);
    await addMember(t.dal, f.scope, second);
    await expectPgError(
      t.app.query(
        "update budget_members set role = 'owner' where budget_id = $1 and user_id = $2",
        [f.budget.id, second.userId],
      ),
      "23505",
    );
    await expectPgError(
      t.app.query(
        "insert into budgets (id, name, timezone, created_at, updated_at) values ($1, 'Ownerless', 'UTC', now(), now())",
        [randomUUID()],
      ),
      "23514",
    );
  });
});

describe("members and ownership transfer", () => {
  it("transfers ownership, then the former owner can leave", async () => {
    const owner = await newUser(t.dal);
    const member = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId);
    await addMember(t.dal, f.scope, member);
    await expectDalError(
      t.dal.members.removeMember(f.scope, owner.userId),
      "OWNER_CANNOT_LEAVE",
    );
    await expectDalError(
      t.dal.members.transferOwnership(f.scope, owner.userId),
      "VALIDATION_FAILED",
    );
    await expectDalError(
      t.dal.members.transferOwnership(f.scope, randomUUID()),
      "NOT_FOUND",
    );
    const { members } = await t.dal.members.transferOwnership(
      f.scope,
      member.userId,
    );
    expect(members.find((m) => m.userId === member.userId)?.role).toBe("owner");
    // The old scope's owner role is stale: the DAL re-checks under the lock.
    await expectDalError(
      t.dal.members.transferOwnership(f.scope, member.userId),
      "FORBIDDEN",
    );
    const oldOwnerScope = await t.dal.requireMembership(
      owner.userId,
      f.budget.id,
    );
    expect(oldOwnerScope.role).toBe("member");
    await t.dal.members.removeMember(oldOwnerScope, owner.userId);
    expect(
      await t.dal.members.listMembers(
        await t.dal.requireMembership(member.userId, f.budget.id),
      ),
    ).toHaveLength(1);
  });

  it("refuses a transfer to a member pending deletion and lets members remove only themselves", async () => {
    const owner = await newUser(t.dal);
    const a = await newUser(t.dal);
    const b = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId);
    const as = await addMember(t.dal, f.scope, a);
    await addMember(t.dal, f.scope, b);
    await expectDalError(t.dal.members.removeMember(as, b.userId), "FORBIDDEN");
    await t.dal.users.requestAccountDeletion(b.userId);
    await expectDalError(
      t.dal.members.transferOwnership(f.scope, b.userId),
      "NOT_FOUND",
    );
    const { removed } = await t.dal.members.removeMember(f.scope, b.userId);
    expect(removed.userId).toBe(b.userId);
  });

  // Race with the target's own deletion request (FINDINGS "Notes for the
  // backend review"): both orders must leave no owner pending deletion.
  it("a transfer waiting on the target's deletion request gets NOT_FOUND", async () => {
    const owner = await newUser(t.dal);
    const target = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId);
    await addMember(t.dal, f.scope, target);
    const deleted = gate();
    const hold = gate();
    const deletion = t.dal.transaction(async (tx) => {
      await tx.users.requestAccountDeletion(target.userId);
      deleted.open();
      await hold.promise;
    });
    await deleted.promise;
    const transfer = Promise.allSettled([
      t.dal.members.transferOwnership(f.scope, target.userId),
    ]);
    await waitForLockWaiters(t.admin); // blocked on the target's user row
    hold.open();
    await deletion;
    const [result] = await transfer;
    expect(result).toMatchObject({
      status: "rejected",
      reason: { name: "DalError", code: "NOT_FOUND" },
    });
    const roles = await t.dal.members.listMembers(f.scope);
    expect(roles.find((m) => m.userId === owner.userId)?.role).toBe("owner");
  });

  it("a deletion request waiting on a transfer to that user gets OWNS_SHARED_BUDGET", async () => {
    const owner = await newUser(t.dal);
    const target = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId);
    await addMember(t.dal, f.scope, target);
    const transferred = gate();
    const hold = gate();
    const transfer = t.dal.transaction(async (tx) => {
      await tx.members.transferOwnership(f.scope, target.userId);
      transferred.open();
      await hold.promise;
    });
    await transferred.promise;
    const deletion = Promise.allSettled([
      t.dal.users.requestAccountDeletion(target.userId),
    ]);
    await waitForLockWaiters(t.admin); // blocked on its own user row
    hold.open();
    await transfer;
    const [result] = await deletion;
    expect(result).toMatchObject({
      status: "rejected",
      reason: { name: "DalError", code: "OWNS_SHARED_BUDGET" },
    });
    expect(await t.dal.users.getMe(target.userId)).toMatchObject({
      status: "active",
      deletion: null,
    });
    const scope = await t.dal.requireMembership(target.userId, f.budget.id);
    expect(scope.role).toBe("owner");
  });
});

describe("invitations", () => {
  it("accepts only for the addressed, verified email, under all the rules", async () => {
    const owner = await newUser(t.dal);
    const invitee = await newUser(t.dal);
    const stranger = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId);
    const { invitation, inviteeHasAccount } =
      await t.dal.invitations.createBudgetInvitation(
        f.scope,
        invitee.email.toUpperCase(),
      );
    expect(inviteeHasAccount).toBe(true);
    expect(invitation.email).toBe(invitee.email);
    await expectDalError(
      t.dal.invitations.createBudgetInvitation(f.scope, invitee.email),
      "ALREADY_EXISTS",
    );
    expect(
      await t.dal.invitations.listMyInvitations(invitee.userId),
    ).toHaveLength(1);
    await expectDalError(
      t.dal.invitations.acceptInvitation(stranger.userId, invitation.id),
      "NOT_FOUND",
    );
    const { budget, owner: ownerContact } =
      await t.dal.invitations.acceptInvitation(invitee.userId, invitation.id);
    expect(budget).toMatchObject({
      id: f.budget.id,
      myRole: "member",
      memberCount: 2,
    });
    expect(ownerContact.userId).toBe(owner.userId);
    await expectDalError(
      t.dal.invitations.acceptInvitation(invitee.userId, invitation.id),
      "INVITATION_INVALID",
    );
    await expectDalError(
      t.dal.invitations.createBudgetInvitation(f.scope, invitee.email),
      "ALREADY_EXISTS",
    );
    const list = await t.dal.invitations.listBudgetInvitations(f.scope);
    expect(list[0]).toMatchObject({
      status: "accepted",
      invitedByDisplayName: "Test User",
    });
  });

  it("expires after 14 days, can be replaced, revoked and declined", async () => {
    const owner = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId);
    const email = uniqueEmail("future");
    const { invitation, inviteeHasAccount } =
      await t.dal.invitations.createBudgetInvitation(f.scope, email);
    expect(inviteeHasAccount).toBe(false);
    t.clock.advance(14 * DAY_MS);
    expect(
      (await t.dal.invitations.listBudgetInvitations(f.scope))[0]?.status,
    ).toBe("expired");
    await expectDalError(
      t.dal.invitations.revokeBudgetInvitation(f.scope, invitation.id),
      "INVITATION_INVALID",
    );
    // The invitee signs up later; the expired invitation cannot be accepted.
    const later = await newUser(t.dal, { email });
    await expectDalError(
      t.dal.invitations.acceptInvitation(later.userId, invitation.id),
      "INVITATION_INVALID",
    );
    const again = await t.dal.invitations.createBudgetInvitation(
      f.scope,
      email,
    );
    await t.dal.invitations.declineInvitation(
      later.userId,
      again.invitation.id,
    );
    const third = await t.dal.invitations.createBudgetInvitation(
      f.scope,
      email,
    );
    await t.dal.invitations.revokeBudgetInvitation(
      f.scope,
      third.invitation.id,
    );
    await expectDalError(
      t.dal.invitations.acceptInvitation(later.userId, third.invitation.id),
      "INVITATION_INVALID",
    );
    t.clock.set(START);
  });

  it("enforces 10 pending per budget, 20 per invitee email and 6 members", async () => {
    const owner = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId);
    const users = [];
    for (let i = 0; i < 10; i++) users.push(await newUser(t.dal));
    for (const u of users)
      await t.dal.invitations.createBudgetInvitation(f.scope, u.email);
    await expectDalError(
      t.dal.invitations.createBudgetInvitation(f.scope, uniqueEmail()),
      "LIMIT_REACHED",
    );
    const mine = await t.dal.invitations.listBudgetInvitations(f.scope);
    for (const u of users.slice(0, 5)) {
      const inv = mine.find((i) => i.email === u.email);
      await t.dal.invitations.acceptInvitation(u.userId, inv?.id ?? "");
    }
    const sixth = users[5]!;
    await expectDalError(
      t.dal.invitations.acceptInvitation(
        sixth.userId,
        mine.find((i) => i.email === sixth.email)?.id ?? "",
      ),
      "LIMIT_REACHED",
    );

    const popular = uniqueEmail("popular");
    for (let i = 0; i < 20; i++) {
      const o = await newUser(t.dal);
      const b = await newBudget(t.dal, o.userId, []);
      await t.dal.invitations.createBudgetInvitation(b.scope, popular);
    }
    const o21 = await newUser(t.dal);
    const b21 = await newBudget(t.dal, o21.userId, []);
    await expectDalError(
      t.dal.invitations.createBudgetInvitation(b21.scope, popular),
      "LIMIT_REACHED",
    );
  });

  it("is invalid when the owner is pending deletion or the budget was deleted", async () => {
    const owner = await newUser(t.dal);
    const invitee = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId);
    const { invitation } = await t.dal.invitations.createBudgetInvitation(
      f.scope,
      invitee.email,
    );
    await t.dal.budgets.deleteBudget(f.scope, 1);
    await expectDalError(
      t.dal.invitations.acceptInvitation(invitee.userId, invitation.id),
      "INVITATION_INVALID",
    );
    expect(await t.dal.invitations.listMyInvitations(invitee.userId)).toEqual(
      [],
    );
  });

  it("serializes acceptance against the owner's deletion request (F-25)", async () => {
    const owner = await newUser(t.dal);
    const invitee = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId);
    const { invitation } = await t.dal.invitations.createBudgetInvitation(
      f.scope,
      invitee.email,
    );
    const [accept, deletion] = await Promise.allSettled([
      t.dal.invitations.acceptInvitation(invitee.userId, invitation.id),
      t.dal.users.requestAccountDeletion(owner.userId),
    ]);
    // Exactly one of the two outcomes, never an owner pending deletion with a new co-member.
    const acceptedFirst = accept.status === "fulfilled";
    expect(
      acceptedFirst
        ? deletion.status === "rejected"
        : deletion.status === "fulfilled",
    ).toBe(true);
    if (acceptedFirst && deletion.status === "rejected")
      expect(deletion.reason).toMatchObject({ code: "OWNS_SHARED_BUDGET" });
    if (!acceptedFirst)
      expect(accept.reason).toMatchObject({ code: "INVITATION_INVALID" });
  });
});

describe("categories", () => {
  it("creates, renames, archives and deletes unused categories", async () => {
    const owner = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId, []);
    const a = await t.dal.categories.createCategory(f.scope, {
      name: "Travel",
      kind: "expense",
    });
    expect(a).toMatchObject({ sortOrder: 0, archived: false, version: 1 });
    const b = await t.dal.categories.createCategory(f.scope, {
      name: "Pets",
      kind: "expense",
    });
    expect(b.sortOrder).toBe(1);
    await expectDalError(
      t.dal.categories.createCategory(f.scope, {
        name: "TRAVEL",
        kind: "income",
      }),
      "ALREADY_EXISTS",
    );
    await expectDalError(
      t.dal.categories.updateCategory(f.scope, b.id, {
        name: "travel",
        version: 1,
      }),
      "ALREADY_EXISTS",
    );
    const archived = await t.dal.categories.updateCategory(f.scope, a.id, {
      archived: true,
      version: 1,
    });
    expect(archived).toMatchObject({ archived: true, version: 2 });
    await expectDalError(
      t.dal.categories.createCategory(f.scope, {
        name: "travel",
        kind: "expense",
      }),
      "ALREADY_EXISTS",
    );
    await expectPgError(
      t.app.query("update categories set kind = 'income' where id = $1", [
        a.id,
      ]),
      "23514",
    );

    await t.dal.transactions.createTransaction(f.scope, {
      date: "2026-11-01",
      direction: "outflow",
      amountCents: 1,
      splits: [{ categoryId: b.id, amountCents: 1 }],
    });
    await expectDalError(
      t.dal.categories.deleteCategory(f.scope, b.id, 1),
      "CATEGORY_IN_USE",
    );
    await t.dal.plans
      .putPlanEntry(f.scope, "2026-11", a.id, { amountCents: 0, version: null })
      .catch(() => undefined);
    await t.dal.categories.deleteCategory(f.scope, a.id, 2);
    await expectDalError(
      t.dal.categories.getCategory(f.scope, a.id),
      "NOT_FOUND",
    );
  });

  it("stops at 100 categories", async () => {
    const owner = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId, []);
    for (let i = 0; i < 100; i++)
      await t.dal.categories.createCategory(f.scope, {
        name: `C${i}`,
        kind: "expense",
      });
    await expectDalError(
      t.dal.categories.createCategory(f.scope, {
        name: "C100",
        kind: "expense",
      }),
      "LIMIT_REACHED",
    );
  });
});

describe("plans", () => {
  it("creates and updates entries with versions and refuses archived categories", async () => {
    const owner = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId);
    const g = f.categories.Groceries ?? "";
    const created = await t.dal.plans.putPlanEntry(f.scope, "2027-01", g, {
      amountCents: 100,
      version: null,
    });
    expect(created).toMatchObject({
      month: "2027-01",
      amountCents: 100,
      version: 1,
    });
    await expectDalError(
      t.dal.plans.putPlanEntry(f.scope, "2027-01", g, {
        amountCents: 1,
        version: null,
      }),
      "VERSION_CONFLICT",
    );
    const updated = await t.dal.plans.putPlanEntry(f.scope, "2027-01", g, {
      amountCents: 200,
      version: 1,
    });
    expect(updated.version).toBe(2);
    await expectDalError(
      t.dal.plans.putPlanEntry(f.scope, "2027-01", g, {
        amountCents: 1,
        version: 1,
      }),
      "VERSION_CONFLICT",
    );
    await expectDalError(
      t.dal.plans.putPlanEntry(f.scope, "2027-01", randomUUID(), {
        amountCents: 1,
        version: null,
      }),
      "NOT_FOUND",
    );
    const cat = await t.dal.categories.getCategory(f.scope, g);
    await t.dal.categories.updateCategory(f.scope, g, {
      archived: true,
      version: cat.version,
    });
    await expectDalError(
      t.dal.plans.putPlanEntry(f.scope, "2027-02", g, {
        amountCents: 1,
        version: null,
      }),
      "CATEGORY_ARCHIVED",
    );
  });

  it("copies the previous month across a year boundary, skipping archived and existing entries", async () => {
    const owner = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId, [
      { name: "A", kind: "expense" },
      { name: "B", kind: "expense" },
      { name: "C", kind: "income" },
    ]);
    const [a, b, c] = ["A", "B", "C"].map((n) => f.categories[n] ?? "");
    await t.dal.plans.putPlanEntry(f.scope, "2026-12", a!, {
      amountCents: 100,
      version: null,
    });
    await t.dal.plans.putPlanEntry(f.scope, "2026-12", b!, {
      amountCents: 200,
      version: null,
    });
    await t.dal.plans.putPlanEntry(f.scope, "2026-12", c!, {
      amountCents: 300,
      version: null,
    });
    await t.dal.plans.putPlanEntry(f.scope, "2027-01", b!, {
      amountCents: 999,
      version: null,
    });
    const cc = await t.dal.categories.getCategory(f.scope, c!);
    await t.dal.categories.updateCategory(f.scope, c!, {
      archived: true,
      version: cc.version,
    });
    const r = await t.dal.plans.copyPreviousMonthPlan(f.scope, "2027-01");
    expect(r).toMatchObject({
      sourceMonth: "2026-12",
      copiedCount: 1,
      skippedCount: 2,
    });
    expect(r.items.map((i) => i.amountCents).sort()).toEqual([100, 999]);
    const o = await t.dal.plans.copyPreviousMonthPlan(f.scope, "2027-01", {
      overwrite: true,
    });
    expect(o).toMatchObject({ copiedCount: 2, skippedCount: 1 });
    expect(o.items.map((i) => i.amountCents).sort()).toEqual([100, 200]);
    const empty = await t.dal.plans.copyPreviousMonthPlan(f.scope, "2026-11");
    expect(empty.copiedCount).toBe(0);
  });
});
