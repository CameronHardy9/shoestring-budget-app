import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DAY_MS } from "../context.ts";
import { csvCell, formatCents } from "../csv.ts";
import { resetDatabase } from "../testing/index.ts";
import {
  addMember,
  csrf,
  hash32,
  newBudget,
  newUser,
} from "../test-support/fixtures.ts";
import { START, useTestDb } from "../test-support/harness.ts";

const t = useTestDb();
const at = (days: number) => new Date(Date.parse(START) + days * DAY_MS);

async function exists(table: string, id: string): Promise<boolean> {
  const r = await t.admin.query(`select 1 from ${table} where id = $1`, [id]);
  return r.rowCount === 1;
}

describe("runPurge", () => {
  it("purges a user after 30 days with every budget they own, including soft-deleted shared ones (F-35)", async () => {
    t.clock.set(START);
    const leaving = await newUser(t.dal);
    const friend = await newUser(t.dal);
    const solo = await newBudget(t.dal, leaving.userId, undefined, "Solo");
    const shared = await newBudget(
      t.dal,
      leaving.userId,
      undefined,
      "Shared, deleted",
    );
    await addMember(t.dal, shared.scope, friend);
    await t.dal.transactions.createTransaction(shared.scope, {
      date: "2026-11-01",
      direction: "outflow",
      amountCents: 10,
      splits: [
        { categoryId: shared.categories.Groceries ?? "", amountCents: 10 },
      ],
    });
    await t.dal.budgets.deleteBudget(shared.scope, 1);
    // The leaving user is also a member of the friend's budget and wrote there.
    const friends = await newBudget(
      t.dal,
      friend.userId,
      undefined,
      "Friend's",
    );
    const asMember = await addMember(t.dal, friends.scope, leaving);
    const written = await t.dal.transactions.createTransaction(asMember, {
      date: "2026-11-02",
      direction: "outflow",
      amountCents: 20,
      splits: [
        { categoryId: friends.categories.Dining ?? "", amountCents: 20 },
      ],
    });
    await t.dal.securityEvents.recordSecurityEvent({
      type: "login_succeeded",
      userId: leaving.userId,
    });
    await t.dal.users.requestAccountDeletion(leaving.userId);

    t.clock.set(at(29));
    expect((await t.dal.purge.runPurge()).usersPurged).toBe(0);
    t.clock.set(at(30));
    const dry = await t.dal.purge.runPurge({ dryRun: true });
    expect(dry).toMatchObject({
      usersPurged: 1,
      ownedBudgetsPurged: 2,
      failed: false,
    });
    expect(await exists("users", leaving.userId)).toBe(true);

    const res = await t.dal.purge.runPurge();
    expect(res).toMatchObject({
      usersPurged: 1,
      usersSkipped: 0,
      ownedBudgetsPurged: 2,
      failed: false,
    });
    expect(await exists("users", leaving.userId)).toBe(false);
    expect(await exists("budgets", solo.budget.id)).toBe(false);
    expect(await exists("budgets", shared.budget.id)).toBe(false);
    expect(await exists("budgets", friends.budget.id)).toBe(true);
    // FK cascade removed the audit rows although `app` has no DELETE on them.
    const ev = await t.admin.query(
      "select count(*)::int as n from security_events where user_id = $1",
      [leaving.userId],
    );
    expect(ev.rows[0]).toEqual({ n: 0 });
    const tx = await t.dal.transactions.getTransaction(
      friends.scope,
      written.value.id,
    );
    expect(tx.createdByUserId).toBeNull();
    expect((await t.dal.purge.runPurge()).usersPurged).toBe(0); // idempotent
  });

  it("skips (and fails the run for) a user whose live owned budget gained a member", async () => {
    t.clock.set(START);
    const owner = await newUser(t.dal);
    const sneaky = await newUser(t.dal);
    const f = await newBudget(t.dal, owner.userId);
    await t.dal.users.requestAccountDeletion(owner.userId);
    // Only a bug or a race could do this; simulate it directly.
    await t.admin.query(
      "insert into budget_members values ($1, $2, 'member', now(), now(), now())",
      [f.budget.id, sneaky.userId],
    );
    t.clock.set(at(31));
    const res = await t.dal.purge.runPurge();
    expect(res).toMatchObject({ usersSkipped: 1, failed: true });
    expect(await exists("users", owner.userId)).toBe(true);
    expect(await exists("budgets", f.budget.id)).toBe(true);
    await t.admin.query("delete from budget_members where user_id = $1", [
      sneaky.userId,
    ]);
  });

  it("removes expired rows, old soft-deleted data and old audit events; dry runs delete nothing", async () => {
    t.clock.set(START);
    const user = await newUser(t.dal);
    const f = await newBudget(t.dal, user.userId);
    const keep = await newBudget(t.dal, user.userId, undefined, "Keep");
    await t.dal.sessions.createSession({
      userId: user.userId,
      tokenHash: hash32(),
      csrfToken: csrf(),
      status: "active",
      deviceBrowser: "chrome",
      deviceOs: "macos",
    });
    const tx = await t.dal.transactions.createTransaction(
      keep.scope,
      {
        date: "2026-11-05",
        direction: "outflow",
        amountCents: 5,
        splits: [
          { categoryId: keep.categories.Groceries ?? "", amountCents: 5 },
        ],
      },
      {
        idempotency: {
          userId: user.userId,
          key: randomUUID(),
          requestHash: hash32(),
        },
      },
    );
    await t.dal.transactions.deleteTransaction(
      keep.scope,
      tx.value.id,
      tx.value.version,
    );
    await t.dal.throttles.hitThrottle(
      { scope: "login:ip", keyHash: hash32() },
      new Date(START),
    );
    await t.dal.budgets.deleteBudget(f.scope, 1);
    await t.dal.invitations.createBudgetInvitation(
      keep.scope,
      "nobody@example.test",
    );
    await t.admin.query(
      "insert into security_events (id, user_id, type, created_at) values ($1, $2, 'logout', now() - interval '91 days')",
      [randomUUID(), user.userId],
    );

    t.clock.set(at(45)); // session expired 15 days ago; deletions 45 days old; invitation expired 31 days ago
    const dry = await t.dal.purge.runPurge({ dryRun: true });
    const real = await t.dal.purge.runPurge();
    expect(real).toEqual(dry);
    expect(real).toMatchObject({
      budgetsPurged: 1,
      transactionsPurged: 1,
      idempotencyKeys: 1,
      authThrottles: 1,
      invitations: 1,
      securityEvents: 1,
      failed: false,
    });
    expect(real.sessions).toBeGreaterThanOrEqual(1);
    expect(await exists("budgets", f.budget.id)).toBe(false);
    expect(await exists("transactions", tx.value.id)).toBe(false);
    const again = await t.dal.purge.runPurge();
    expect(again).toMatchObject({
      budgetsPurged: 0,
      transactionsPurged: 0,
      sessions: 0,
      securityEvents: 0,
    });
    t.clock.set(START);
  });
});

describe("CSV export", () => {
  it("formats cents and escapes cells, prefixing formula starters in user text", () => {
    expect(formatCents(0)).toBe("0.00");
    expect(formatCents(5)).toBe("0.05");
    expect(formatCents(123_456)).toBe("1234.56");
    expect(formatCents(100_000_000)).toBe("1000000.00");
    expect(() => formatCents(-1)).toThrow(RangeError);
    expect(() => formatCents(1.5)).toThrow(RangeError);
    expect(csvCell("=SUM(A1)", true)).toBe("'=SUM(A1)");
    expect(csvCell("-5", true)).toBe("'-5");
    expect(csvCell("@x", true)).toBe("'@x");
    expect(csvCell("+1", true)).toBe("'+1");
    expect(csvCell("\tx", true)).toBe("'\tx");
    expect(csvCell('say "hi", ok', true)).toBe('"say ""hi"", ok"');
    expect(csvCell("-5", false)).toBe("-5");
  });

  it("exports every live budget of the user, one row per split, including co-members' entries", async () => {
    t.clock.set(START);
    const me = await newUser(t.dal, { displayName: "Me" });
    const partner = await newUser(t.dal, { displayName: "=Partner" });
    const f = await newBudget(t.dal, me.userId, undefined, "Home");
    const ps = await addMember(t.dal, f.scope, partner);
    await t.dal.transactions.createTransaction(ps, {
      date: "2026-11-03",
      direction: "outflow",
      amountCents: 1550,
      payee: "-Market",
      memo: "weekly, big",
      splits: [
        { categoryId: f.categories.Groceries ?? "", amountCents: 1500 },
        { categoryId: f.categories.Dining ?? "", amountCents: 50 },
      ],
    });
    const gone = await newBudget(t.dal, me.userId, undefined, "Gone");
    await t.dal.budgets.deleteBudget(gone.scope, 1);

    const csv = await t.dal.exports.exportTransactionsCsv(me.userId);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "budget_name,transaction_id,date,direction,total_amount,split_category,split_amount,payee,memo,created_by,created_at_utc",
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(
      ",2026-11-03,outflow,15.50,Groceries,15.00,'-Market,\"weekly, big\",'=Partner,2026-11-13T15:00:00.000Z",
    );
    expect(lines[2]).toContain(",Dining,0.50,");
    expect(csv).not.toContain("Gone");

    const plans = await t.dal.exports.exportPlansCsv(me.userId);
    expect(plans.split("\r\n")[0]).toBe(
      "budget_name,month,category,category_kind,planned_amount",
    );
    expect(plans).toContain("Home,2026-11,Groceries,expense,500.00");
    expect(plans).toContain("Home,2026-11,Salary,income,4000.00");
  });
});

describe("resetDatabase (test hooks)", () => {
  it("empties every table but keeps the schema version", async () => {
    await newUser(t.dal);
    await resetDatabase(t.adminUrl);
    const r = await t.admin.query(
      "select (select count(*)::int from users) as users, (select count(*)::int from schema_migrations) as versions",
    );
    expect(r.rows[0]).toEqual({
      users: 0,
      versions: expect.any(Number) as number,
    });
    expect(await t.dal.health.isSchemaCurrent()).toBe(true);
  });
});
