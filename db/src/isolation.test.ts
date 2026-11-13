// Two-household isolation suite (ADR-0006, F-18, R-7): every budget DAL
// function runs with a scope for budget A against IDs of budget B and must
// neither read nor change B. The coverage check at the bottom fails when a new
// function in a budget-domain module is not listed here.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Dal } from "./dal.ts";
import * as budgetsRepo from "./repos/budgets.ts";
import * as categoriesRepo from "./repos/categories.ts";
import * as exportsRepo from "./repos/exports.ts";
import * as invitationsRepo from "./repos/invitations.ts";
import * as membersRepo from "./repos/members.ts";
import * as plansRepo from "./repos/plans.ts";
import * as summaryRepo from "./repos/summary.ts";
import * as transactionsRepo from "./repos/transactions.ts";
import type { BudgetScope } from "./scope.ts";
import type { BudgetFixture } from "./test-support/fixtures.ts";
import {
  addMember,
  expectDalError,
  newBudget,
  newUser,
} from "./test-support/fixtures.ts";
import { useTestDb } from "./test-support/harness.ts";

const t = useTestDb();

let A: BudgetFixture;
let B: BudgetFixture;
let ownerB: { userId: string; email: string };
let memberB: { userId: string; email: string };
let txB: { id: string; version: number };
let invB: string;
let snapshotB: string;

async function snapshot(): Promise<string> {
  const r = await t.admin.query<{ s: string | null }>(
    `select (select json_agg(x order by x.id) from budgets x where id = $1)::text
         || (select json_agg(x order by x.user_id) from budget_members x where budget_id = $1)::text
         || (select json_agg(x order by x.id) from budget_invitations x where budget_id = $1)::text
         || (select json_agg(x order by x.id) from categories x where budget_id = $1)::text
         || coalesce((select json_agg(x order by x.id) from plan_entries x where budget_id = $1)::text, '')
         || (select json_agg(x order by x.id) from transactions x where budget_id = $1)::text
         || (select json_agg(x order by x.id) from transaction_splits x where budget_id = $1)::text as s`,
    [B.budget.id],
  );
  return r.rows[0]?.s ?? "";
}

beforeAll(async () => {
  const ownerA = await newUser(t.dal);
  ownerB = await newUser(t.dal);
  memberB = await newUser(t.dal);
  A = await newBudget(t.dal, ownerA.userId, undefined, "Household A");
  B = await newBudget(t.dal, ownerB.userId, undefined, "Household B");
  await addMember(t.dal, B.scope, memberB);
  const created = await t.dal.transactions.createTransaction(B.scope, {
    date: "2026-11-02",
    direction: "outflow",
    amountCents: 4200,
    payee: "B only",
    splits: [{ categoryId: B.categories.Groceries ?? "", amountCents: 4200 }],
  });
  txB = { id: created.value.id, version: created.value.version };
  await t.dal.plans.putPlanEntry(
    B.scope,
    "2026-12",
    B.categories.Groceries ?? "",
    { amountCents: 1, version: null },
  );
  invB = (
    await t.dal.invitations.createBudgetInvitation(
      B.scope,
      "pending-b@example.test",
    )
  ).invitation.id;
  snapshotB = await snapshot();
});

const bCat = () => B.categories.Groceries ?? "";
const split = () => [{ categoryId: bCat(), amountCents: 100 }];

/** Each entry: function name -> call with A's scope and B's IDs, and the expected outcome. */
const CASES: Record<string, (dal: Dal, s: BudgetScope) => Promise<unknown>> = {
  // budgets
  getBudget: async (dal, s) =>
    expect((await dal.budgets.getBudget(s)).id).toBe(A.budget.id),
  updateBudget: async (dal, s) =>
    expect(
      (await dal.budgets.updateBudget(s, { name: "A renamed", version: 1 })).id,
    ).toBe(A.budget.id),
  deleteBudget: async () => undefined, // covered by "deleteBudget only touches A" below
  listMemberContacts: async (dal, s) =>
    expect(
      (await dal.budgets.listMemberContacts(s)).map((c) => c.userId),
    ).not.toContain(ownerB.userId),
  listBudgetsForUser: async (dal) =>
    expect(
      (await dal.budgets.listBudgetsForUser(A.scope.userId)).map((b) => b.id),
    ).not.toContain(B.budget.id),
  createBudget: async () => undefined, // creates a new tenant; no foreign IDs involved
  listDeletedBudgets: async (dal) =>
    expect(await dal.budgets.listDeletedBudgets(A.scope.userId)).toEqual([]),
  restoreDeletedBudget: async (dal, s) =>
    expectDalError(
      dal.requireDeletedBudgetOwnership(s.userId, B.budget.id),
      "NOT_FOUND",
    ),
  // members
  listMembers: async (dal, s) =>
    expect((await dal.members.listMembers(s)).map((m) => m.userId)).toEqual([
      s.userId,
    ]),
  removeMember: async (dal, s) =>
    expectDalError(dal.members.removeMember(s, memberB.userId), "NOT_FOUND"),
  transferOwnership: async (dal, s) =>
    expectDalError(
      dal.members.transferOwnership(s, memberB.userId),
      "NOT_FOUND",
    ),
  // invitations
  listBudgetInvitations: async (dal, s) =>
    expect(
      (await dal.invitations.listBudgetInvitations(s)).map((i) => i.id),
    ).not.toContain(invB),
  createBudgetInvitation: async (dal, s) =>
    expect(
      (await dal.invitations.createBudgetInvitation(s, memberB.email))
        .invitation.budgetId,
    ).toBe(A.budget.id),
  revokeBudgetInvitation: async (dal, s) =>
    expectDalError(
      dal.invitations.revokeBudgetInvitation(s, invB),
      "NOT_FOUND",
    ),
  listMyInvitations: async () => undefined, // user-scoped by email; covered in budgets.test.ts
  acceptInvitation: async (dal, s) =>
    expectDalError(
      dal.invitations.acceptInvitation(s.userId, invB),
      "NOT_FOUND",
    ),
  declineInvitation: async (dal, s) =>
    expectDalError(
      dal.invitations.declineInvitation(s.userId, invB),
      "NOT_FOUND",
    ),
  // categories
  listCategories: async (dal, s) =>
    expect(
      (await dal.categories.listCategories(s)).map((c) => c.id),
    ).not.toContain(bCat()),
  getCategory: async (dal, s) =>
    expectDalError(dal.categories.getCategory(s, bCat()), "NOT_FOUND"),
  createCategory: async (dal, s) =>
    expect(
      (
        await dal.categories.createCategory(s, {
          name: "Isolation",
          kind: "expense",
        })
      ).budgetId,
    ).toBe(A.budget.id),
  updateCategory: async (dal, s) =>
    expectDalError(
      dal.categories.updateCategory(s, bCat(), { name: "Hacked", version: 1 }),
      "NOT_FOUND",
    ),
  deleteCategory: async (dal, s) =>
    expectDalError(dal.categories.deleteCategory(s, bCat(), 1), "NOT_FOUND"),
  // plans
  getMonthPlan: async (dal, s) =>
    expect((await dal.plans.getMonthPlan(s, "2026-12")).items).toEqual([]),
  putPlanEntry: async (dal, s) =>
    expectDalError(
      dal.plans.putPlanEntry(s, "2026-12", bCat(), {
        amountCents: 5,
        version: 1,
      }),
      "NOT_FOUND",
    ),
  copyPreviousMonthPlan: async (dal, s) =>
    expect(
      (await dal.plans.copyPreviousMonthPlan(s, "2027-01")).copiedCount,
    ).toBe(0),
  // transactions
  getTransaction: async (dal, s) =>
    expectDalError(dal.transactions.getTransaction(s, txB.id), "NOT_FOUND"),
  listTransactions: async (dal, s) => {
    expect(
      (await dal.transactions.listTransactions(s)).items.map((x) => x.id),
    ).not.toContain(txB.id);
    expect(
      (await dal.transactions.listTransactions(s, { categoryId: bCat() }))
        .items,
    ).toEqual([]);
  },
  createTransaction: async (dal, s) =>
    expectDalError(
      dal.transactions.createTransaction(s, {
        date: "2026-11-03",
        direction: "outflow",
        amountCents: 100,
        splits: split(),
      }),
      "VALIDATION_FAILED",
    ),
  replaceTransaction: async (dal, s) =>
    expectDalError(
      dal.transactions.replaceTransaction(s, txB.id, {
        date: "2026-11-03",
        direction: "outflow",
        amountCents: 100,
        splits: split(),
        version: txB.version,
      }),
      "NOT_FOUND",
    ),
  deleteTransaction: async (dal, s) =>
    expectDalError(
      dal.transactions.deleteTransaction(s, txB.id, txB.version),
      "NOT_FOUND",
    ),
  // summary and export
  getMonthSummary: async (dal, s) => {
    const sum = await dal.summary.getMonthSummary(s, "2026-11");
    expect(sum.transactionCount).toBe(0);
    expect(sum.categories.map((c) => c.categoryId)).not.toContain(bCat());
  },
  exportTransactionsCsv: async (dal, s) =>
    expect(await dal.exports.exportTransactionsCsv(s.userId)).not.toContain(
      "Household B",
    ),
  exportPlansCsv: async (dal, s) =>
    expect(await dal.exports.exportPlansCsv(s.userId)).not.toContain(
      "Household B",
    ),
};

describe("two-household isolation", () => {
  it("non-members cannot obtain a scope for another budget", async () => {
    await expectDalError(
      t.dal.requireMembership(A.scope.userId, B.budget.id),
      "NOT_FOUND",
    );
    await expectDalError(
      t.dal.requireMembership(A.scope.userId, randomUUID()),
      "NOT_FOUND",
    );
    await expectDalError(
      t.dal.requireMembership(A.scope.userId, "not-a-uuid"),
      "NOT_FOUND",
    );
  });

  it("a forged scope is rejected at runtime, not just by the type checker", async () => {
    const forged = {
      budgetId: B.budget.id,
      userId: A.scope.userId,
      role: "owner",
    } as unknown as BudgetScope;
    await expect(t.dal.transactions.listTransactions(forged)).rejects.toThrow(
      TypeError,
    );
    await expect(
      t.dal.summary.getMonthSummary(forged, "2026-11"),
    ).rejects.toThrow(TypeError);
    await expect(t.dal.budgets.deleteBudget(forged, 1)).rejects.toThrow(
      TypeError,
    );
  });

  for (const [name, call] of Object.entries(CASES)) {
    it(`${name} with A's scope never reads or changes B`, async () => {
      await call(t.dal, A.scope);
      expect(await snapshot()).toBe(snapshotB);
    });
  }

  it("deleteBudget only touches A", async () => {
    const tmp = await newBudget(t.dal, A.scope.userId, [], "Disposable A");
    await t.dal.budgets.deleteBudget(tmp.scope, 1);
    expect(await snapshot()).toBe(snapshotB);
  });

  it("covers every function of every budget-domain module", () => {
    const modules = [
      budgetsRepo,
      membersRepo,
      invitationsRepo,
      categoriesRepo,
      plansRepo,
      transactionsRepo,
      summaryRepo,
      exportsRepo,
    ];
    const names = modules.flatMap((m) =>
      Object.entries(m)
        .filter(([, v]) => typeof v === "function")
        .map(([k]) => k),
    );
    expect(names.filter((n) => !(n in CASES))).toEqual([]);
  });
});
