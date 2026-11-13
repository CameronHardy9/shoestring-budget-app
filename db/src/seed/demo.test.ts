import { describe, expect, it } from "vitest";
import { manualClock } from "../clock.ts";
import { createDal } from "../dal.ts";
import { createDeterministicIdGenerator } from "../ids.ts";
import { fakePasswordHash } from "../test-support/fixtures.ts";
import { useTestDb } from "../test-support/harness.ts";
import { resetDatabase } from "../testing/index.ts";
import { SEED_EMAILS, SEED_START, seedDemoData } from "./demo.ts";

const t = useTestDb();

async function runSeed() {
  const clock = manualClock(SEED_START);
  const dal = createDal({
    connectionString: t.appUrl,
    clock: clock.clock,
    idGenerator: createDeterministicIdGenerator(
      Date.parse(SEED_START),
      20261113,
    ),
  });
  try {
    return await seedDemoData(dal, clock, fakePasswordHash);
  } finally {
    await dal.close();
  }
}

async function fingerprint(): Promise<string> {
  const r = await t.admin.query<{ s: string }>(
    `select string_agg(id::text || date::text || amount_cents::text || created_at::text || coalesce(deleted_at::text, ''), ',' order by id) as s from transactions`,
  );
  return r.rows[0]?.s ?? "";
}

describe("demo seed", () => {
  it("is idempotent and deterministic", async () => {
    await resetDatabase(t.adminUrl);
    const first = await runSeed();
    expect(first).toMatchObject({ created: true, users: 3, budgets: 2 });
    expect(first.transactions).toBeGreaterThan(70);
    expect((await runSeed()).created).toBe(false);
    const a = await fingerprint();
    await resetDatabase(t.adminUrl);
    await runSeed();
    expect(await fingerprint()).toBe(a);
  });

  it("covers the edge cases the summary must get right", async () => {
    const ownerId = await t.dal.users.findUserIdByEmail(SEED_EMAILS.owner);
    const memberId = await t.dal.users.findUserIdByEmail(SEED_EMAILS.member);
    const [budget] = await t.dal.budgets.listBudgetsForUser(ownerId ?? "");
    expect(budget).toMatchObject({
      name: "Demo household",
      memberCount: 2,
      timezone: "America/New_York",
    });
    const scope = await t.dal.requireMembership(
      memberId ?? "",
      budget?.id ?? "",
    );

    const oct = await t.dal.summary.getMonthSummary(scope, "2026-10");
    const transport = oct.categories.find((c) => c.name === "Transport");
    expect(transport?.actualCents).toBeLessThan(0); // refund larger than spending
    expect(oct.categories.find((c) => c.name === "Gym")).toMatchObject({
      archived: true,
    }); // archived, planned this month

    const nov = await t.dal.transactions.listTransactions(scope, {
      month: "2026-11",
    });
    expect(
      nov.items.filter(
        (x) => x.date === "2026-11-01" && x.payee === "Late Diner",
      ),
    ).toHaveLength(2); // DST day
    const dec = await t.dal.summary.getMonthSummary(scope, "2026-12");
    expect(dec.categories.find((c) => c.name === "Gifts")?.plannedCents).toBe(
      0,
    ); // unplanned
    expect(
      dec.categories.find((c) => c.name === "Gifts")?.actualCents,
    ).toBeGreaterThan(0);
    const jan = await t.dal.transactions.listTransactions(scope, {
      month: "2027-01",
    });
    expect(jan.items.some((x) => x.date === "2027-01-01")).toBe(true);
    const splitAcrossIncome = (
      await t.dal.transactions.listTransactions(scope, {
        month: "2026-12",
        limit: 100,
      })
    ).items.find((x) => x.direction === "inflow" && x.splits.length === 2);
    expect(splitAcrossIncome).toBeDefined();
  });
});
