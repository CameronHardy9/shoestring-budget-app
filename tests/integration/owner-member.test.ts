// Owner vs member rules (owner decision D6b, auth.md §12 "Roles", ADR-0010):
// members are equal for money (transactions, categories, plans), only the
// owner manages the budget and its people.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addMember } from "../support/factories.ts";
import { codeOf, detailsOf } from "../support/http.ts";
import { emails } from "../support/hooks.ts";
import { dal } from "../support/dal.ts";
import { persona, seedWorld } from "../support/world.ts";

describe("members are equal for money", () => {
  it("a member edits the owner's transaction, renames and archives categories, sets and copies plans", async () => {
    const w = await seedWorld();
    const m = w.member.client;
    const bp = `/budgets/${w.budget.id}`;
    const edited = await m.put<{ updatedByUserId: string; version: number }>(
      `${bp}/transactions/${w.tx.id}`,
      {
        date: w.today,
        direction: "outflow",
        amountCents: 4_000,
        payee: "Market",
        memo: null,
        splits: [
          { categoryId: w.budget.categories.Groceries!, amountCents: 4_000 },
        ],
        version: w.tx.version,
      },
    );
    expect(edited.status).toBe(200);
    expect(edited.body.updatedByUserId).toBe(w.member.user.userId);
    const cat = await m.patch(
      `${bp}/categories/${w.budget.categories.Dining!}`,
      { archived: true, version: 1 },
    );
    expect(cat.status).toBe(200);
    expect(
      (
        await m.put(
          `${bp}/months/2026-12/plan/${w.budget.categories.Groceries!}`,
          { amountCents: 1, version: null },
        )
      ).status,
    ).toBe(201);
    expect(
      (await m.post(`${bp}/months/2027-01/plan/copy-previous`, {})).status,
    ).toBe(200);
    expect(
      (await m.post(`${bp}/categories`, { name: "Pets", kind: "expense" }))
        .status,
    ).toBe(201);
  });
});

describe("only the owner manages the budget", () => {
  it("a member cannot rename the budget or change its timezone, invite, revoke invitations, or delete it", async () => {
    const w = await seedWorld();
    const m = w.member.client;
    const bp = `/budgets/${w.budget.id}`;
    const { invitation } = await dal().invitations.createBudgetInvitation(
      w.budget.scope,
      "later@example.test",
    );
    for (const res of [
      await m.patch(bp, { name: "Mine now", version: 1 }),
      await m.patch(bp, { timezone: "Europe/London", version: 1 }),
      await m.post(`${bp}/invitations`, { email: "friend@example.test" }),
      await m.get(`${bp}/invitations`),
      await m.delete(`${bp}/invitations/${invitation.id}`),
      await m.delete(bp, { query: { version: 1 } }),
    ])
      expect([res.status, codeOf(res)], res.describe).toEqual([
        403,
        "FORBIDDEN",
      ]);
  });

  it("the owner changes the timezone: today and currentMonth follow it, stored dates do not move", async () => {
    const w = await seedWorld();
    const res = await w.owner.client.patch<{
      timezone: string;
      today: string;
      version: number;
    }>(`/budgets/${w.budget.id}`, {
      timezone: "Pacific/Kiritimati",
      version: w.budget.record.version,
    });
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe("Pacific/Kiritimati");
    expect(res.body.today).toBe("2026-11-17"); // 15:00Z = 05:00 next day at UTC+14
    const tx = await w.owner.client.get<{ date: string }>(
      `/budgets/${w.budget.id}/transactions/${w.tx.id}`,
    );
    expect(tx.body.date).toBe(w.tx.date);
    const stale = await w.owner.client.patch(`/budgets/${w.budget.id}`, {
      name: "Again",
      version: w.budget.record.version,
    });
    expect([stale.status, codeOf(stale)]).toEqual([409, "VERSION_CONFLICT"]);
  });

  it("an unknown timezone is 400 (timezone, invalid_value)", async () => {
    const w = await seedWorld();
    const res = await w.owner.client.patch(`/budgets/${w.budget.id}`, {
      timezone: "Mars/Olympus_Mons",
      version: 1,
    });
    expect([res.status, codeOf(res)]).toEqual([400, "VALIDATION_FAILED"]);
    expect(detailsOf(res)).toContainEqual(
      expect.objectContaining({ field: "timezone", issue: "invalid_value" }),
    );
  });
});

describe("leaving, removal and ownership transfer (ADR-0010)", () => {
  it("a member leaves on their own: no email to anyone, and the budget disappears from their list", async () => {
    const w = await seedWorld();
    const res = await w.member.client.delete(
      `/budgets/${w.budget.id}/members/${w.member.user.userId}`,
    );
    expect(res.status).toBe(204);
    expect((await emails()).filter((e) => e.kind === "member_removed")).toEqual(
      [],
    );
    const list = await w.member.client.get<{ items: unknown[] }>("/budgets");
    expect(list.body.items).toEqual([]);
  });

  it("the owner removes a member: the member gets member_removed (no link) and loses access", async () => {
    const w = await seedWorld();
    expect(
      (
        await w.owner.client.delete(
          `/budgets/${w.budget.id}/members/${w.member.user.userId}`,
        )
      ).status,
    ).toBe(204);
    const mail = (await emails(w.member.user.email)).filter(
      (e) => e.kind === "member_removed",
    );
    expect(mail).toHaveLength(1);
    expect(mail[0]!.links).toEqual([]);
    expect(codeOf(await w.member.client.get(`/budgets/${w.budget.id}`))).toBe(
      "NOT_FOUND",
    );
  });

  it("transfer swaps the roles at once, emails every member, and the former owner may then leave", async () => {
    const w = await seedWorld();
    const res = await w.owner.client.post<{ myRole: string }>(
      `/budgets/${w.budget.id}/transfer-ownership`,
      {
        userId: w.member.user.userId,
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.myRole).toBe("member");
    const members = await w.member.client.get<{
      items: { userId: string; role: string }[];
    }>(`/budgets/${w.budget.id}/members`);
    expect(members.body.items[0]).toMatchObject({
      userId: w.member.user.userId,
      role: "owner",
    });
    for (const u of [w.owner.user, w.member.user]) {
      const mail = (await emails(u.email)).filter(
        (e) => e.kind === "ownership_transferred",
      );
      expect(mail, u.email).toHaveLength(1);
      expect(mail[0]!.links[0]).toMatch(
        new RegExp(`/budgets/${w.budget.id}/members$`),
      );
    }
    expect(
      (
        await w.owner.client.delete(
          `/budgets/${w.budget.id}/members/${w.owner.user.userId}`,
        )
      ).status,
    ).toBe(204);
  });

  it("transfer to yourself is 400 (userId, invalid_value); to a non-member or a member pending deletion is 404", async () => {
    const w = await seedWorld();
    const path = `/budgets/${w.budget.id}/transfer-ownership`;
    const self = await w.owner.client.post(path, {
      userId: w.owner.user.userId,
    });
    expect([self.status, codeOf(self)]).toEqual([400, "VALIDATION_FAILED"]);
    expect(detailsOf(self)).toContainEqual(
      expect.objectContaining({ field: "userId", issue: "invalid_value" }),
    );
    expect(
      codeOf(
        await w.owner.client.post(path, { userId: w.outsider.user.userId }),
      ),
    ).toBe("NOT_FOUND");
    await dal().users.requestAccountDeletion(w.member.user.userId);
    expect(
      codeOf(await w.owner.client.post(path, { userId: w.member.user.userId })),
    ).toBe("NOT_FOUND");
  });

  it("deleting a budget emails every member; only the owner's copy has the restore link", async () => {
    const w = await seedWorld();
    const res = await w.owner.client.delete(`/budgets/${w.budget.id}`, {
      query: { version: w.budget.record.version },
    });
    expect(res.status).toBe(204);
    const owner = (await emails(w.owner.user.email)).find(
      (e) => e.kind === "budget_deleted",
    );
    const member = (await emails(w.member.user.email)).find(
      (e) => e.kind === "budget_deleted",
    );
    expect(owner?.links[0]).toMatch(/\/settings\/deleted-budgets$/);
    expect(member?.links).toEqual([]);
    expect(codeOf(await w.member.client.get(`/budgets/${w.budget.id}`))).toBe(
      "NOT_FOUND",
    );
    const restored = await w.owner.client.post(
      `/me/deleted-budgets/${w.budget.id}/restore`,
    );
    expect(restored.status).toBe(200);
    const notice = (await emails(w.member.user.email)).find(
      (e) => e.kind === "budget_restored",
    );
    expect(notice?.links[0]).toMatch(new RegExp(`/budgets/${w.budget.id}$`));
  });
});

describe("limits (data-model.md 'Limits')", () => {
  it("a budget holds at most 6 members: the 7th acceptance is 422 LIMIT_REACHED", async () => {
    const w = await seedWorld(); // owner + member = 2
    for (let i = 0; i < 4; i++)
      await addMember(w.budget, (await persona(`extra${i}`)).user);
    const seventh = await persona("seventh");
    const { invitation } = await dal().invitations.createBudgetInvitation(
      w.budget.scope,
      seventh.user.email,
    );
    const res = await seventh.client.post(
      `/me/invitations/${invitation.id}/accept`,
    );
    expect([res.status, codeOf(res)]).toEqual([422, "LIMIT_REACHED"]);
  });

  it("a user is in at most 10 budgets: the 11th create is 422 LIMIT_REACHED, a deleted one frees a slot", async () => {
    const p = await persona("collector");
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await p.client.post<{ id: string }>(
        "/budgets",
        { name: `B${i}`, timezone: "UTC" },
        { idempotencyKey: randomUUID() },
      );
      expect(r.status).toBe(201);
      ids.push(r.body.id);
    }
    const eleventh = await p.client.post(
      "/budgets",
      { name: "B10", timezone: "UTC" },
      { idempotencyKey: randomUUID() },
    );
    expect([eleventh.status, codeOf(eleventh)]).toEqual([422, "LIMIT_REACHED"]);
    expect(
      (await p.client.delete(`/budgets/${ids[0]!}`, { query: { version: 1 } }))
        .status,
    ).toBe(204);
    const again = await p.client.post(
      "/budgets",
      { name: "B10", timezone: "UTC" },
      { idempotencyKey: randomUUID() },
    );
    expect(again.status).toBe(201);
    // Restoring the deleted one would make 11 (owner ruling round 2): refused.
    const restore = await p.client.post(
      `/me/deleted-budgets/${ids[0]!}/restore`,
    );
    expect([restore.status, codeOf(restore)]).toEqual([422, "LIMIT_REACHED"]);
  });
});
