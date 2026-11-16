// The invitation flow (J6, auth.md §12 "Budget invitations", data-model.md
// budget_invitations): authorization is the email match, there is no token,
// the create answer is identical whether or not an account exists (no
// enumeration), and only existing accounts are emailed.
// createBudgetInvitation answers at a fixed 1 s (F-22), so this file keeps
// HTTP invitations to the ones under test and seeds the rest through the DAL.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUser } from "../support/factories.ts";
import { ApiClient, codeOf, detailsOf } from "../support/http.ts";
import {
  advanceClock,
  DAY,
  dal,
  emails,
  signupInvite,
  testLogin,
} from "../support/hooks.ts";
import { persona, seedWorld } from "../support/world.ts";

interface Invitation {
  id: string;
  email: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  invitedByDisplayName: string | null;
}

describe("invite → accept (J6)", () => {
  it("the owner invites an existing user, who sees it, accepts, and both now see the same budget", async () => {
    const w = await seedWorld();
    const partner = await persona("partner");
    const created = await w.owner.client.post<Invitation>(
      `/budgets/${w.budget.id}/invitations`,
      { email: partner.user.email.toUpperCase() },
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      email: partner.user.email,
      status: "pending",
      invitedByDisplayName: w.owner.user.displayName,
    });
    expect(
      new Date(created.body.expiresAt).getTime() -
        new Date(created.body.createdAt).getTime(),
    ).toBe(14 * DAY);

    const notice = (await emails(partner.user.email)).filter(
      (e) => e.kind === "budget_invitation",
    );
    expect(notice).toHaveLength(1);
    expect(notice[0]!.links[0]).toMatch(/\/invitations$/);

    const mine = await partner.client.get<{
      items: { id: string; budgetName: string }[];
    }>("/me/invitations");
    expect(mine.body.items).toEqual([
      expect.objectContaining({
        id: created.body.id,
        budgetName: w.budget.record.name,
      }),
    ]);

    const accepted = await partner.client.post<{
      id: string;
      myRole: string;
      memberCount: number;
    }>(`/me/invitations/${created.body.id}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      id: w.budget.id,
      myRole: "member",
      memberCount: 3,
    });

    const ownerMail = (await emails(w.owner.user.email)).filter(
      (e) => e.kind === "invitation_accepted",
    );
    expect(ownerMail).toHaveLength(1);
    expect(ownerMail[0]!.links[0]).toMatch(
      new RegExp(`/budgets/${w.budget.id}/members$`),
    );

    const tx = await partner.client.get<{ items: { id: string }[] }>(
      `/budgets/${w.budget.id}/transactions`,
    );
    expect(tx.body.items.map((t) => t.id)).toEqual([w.tx.id]);
    const list = await w.owner.client.get<{ items: Invitation[] }>(
      `/budgets/${w.budget.id}/invitations`,
    );
    expect(list.body.items[0]).toMatchObject({
      id: created.body.id,
      status: "accepted",
    });
  });

  it("an invite to an address with no account answers the same, sends no email, and waits for that sign-up", async () => {
    const w = await seedWorld();
    const address = `future-${randomBytes(4).toString("hex")}@example.test`;
    const created = await w.owner.client.post<Invitation>(
      `/budgets/${w.budget.id}/invitations`,
      { email: address },
    );
    expect(created.status).toBe(201);
    expect(Object.keys(created.body).sort()).toEqual(
      [
        "budgetId",
        "createdAt",
        "email",
        "expiresAt",
        "id",
        "invitedByDisplayName",
        "respondedAt",
        "status",
      ].sort(),
    );
    expect(await emails(address)).toEqual([]);

    // The address signs up later (invite-only sign-up) and finds the invitation.
    const token = await signupInvite(address);
    const anon = new ApiClient("future");
    const signup = await anon.post("/auth/signup", {
      token,
      displayName: "Future Tester",
      password: `pw-${randomBytes(10).toString("hex")}`,
    });
    expect(signup.status).toBe(201);
    const mine = await anon.get<{ items: { id: string }[] }>("/me/invitations");
    expect(mine.body.items.map((i) => i.id)).toEqual([created.body.id]);
  });

  it("decline: the invitation is answered and can no longer be accepted (400 INVITATION_INVALID)", async () => {
    const w = await seedWorld();
    const p = await persona("decliner");
    const { invitation } = await dal().invitations.createBudgetInvitation(
      w.budget.scope,
      p.user.email,
    );
    expect(
      (await p.client.post(`/me/invitations/${invitation.id}/decline`)).status,
    ).toBe(204);
    const accept = await p.client.post(
      `/me/invitations/${invitation.id}/accept`,
    );
    expect([accept.status, codeOf(accept)]).toEqual([
      400,
      "INVITATION_INVALID",
    ]);
    expect(
      (await p.client.get<{ items: unknown[] }>("/me/invitations")).body.items,
    ).toEqual([]);
  });

  it("revoke: a revoked invitation cannot be accepted, and revoking it again is 400 INVITATION_INVALID", async () => {
    const w = await seedWorld();
    const p = await persona("revoked");
    const { invitation } = await dal().invitations.createBudgetInvitation(
      w.budget.scope,
      p.user.email,
    );
    expect(
      (
        await w.owner.client.delete(
          `/budgets/${w.budget.id}/invitations/${invitation.id}`,
        )
      ).status,
    ).toBe(204);
    expect(
      codeOf(await p.client.post(`/me/invitations/${invitation.id}/accept`)),
    ).toBe("INVITATION_INVALID");
    expect(
      codeOf(
        await w.owner.client.delete(
          `/budgets/${w.budget.id}/invitations/${invitation.id}`,
        ),
      ),
    ).toBe("INVITATION_INVALID");
  });

  it("an invitation expires after 14 days (INVITATION_INVALID, no longer listed); re-inviting replaces it", async () => {
    const w = await seedWorld();
    const p = await createUser({ prefix: "slow" });
    const { invitation } = await dal().invitations.createBudgetInvitation(
      w.budget.scope,
      p.email,
    );
    await advanceClock(14 * DAY + 1_000);
    const client = await testLogin(p.email);
    expect(
      (await client.get<{ items: unknown[] }>("/me/invitations")).body.items,
    ).toEqual([]);
    expect(
      codeOf(await client.post(`/me/invitations/${invitation.id}/accept`)),
    ).toBe("INVITATION_INVALID");
    const owner = await testLogin(w.owner.user.email);
    const again = await owner.post<Invitation>(
      `/budgets/${w.budget.id}/invitations`,
      { email: p.email },
    );
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(invitation.id);
  });
});

describe("invitation rules", () => {
  it("a second pending invite for the same email is 409 ALREADY_EXISTS (invitation_pending)", async () => {
    const w = await seedWorld();
    await dal().invitations.createBudgetInvitation(
      w.budget.scope,
      "twice@example.test",
    );
    const res = await w.owner.client.post(
      `/budgets/${w.budget.id}/invitations`,
      { email: "twice@example.test" },
    );
    expect([res.status, codeOf(res)]).toEqual([409, "ALREADY_EXISTS"]);
    expect(detailsOf(res)).toContainEqual(
      expect.objectContaining({ issue: "invitation_pending" }),
    );
  });

  it("inviting an existing member is 409 ALREADY_EXISTS (already_member)", async () => {
    const w = await seedWorld();
    const res = await w.owner.client.post(
      `/budgets/${w.budget.id}/invitations`,
      { email: w.member.user.email },
    );
    expect([res.status, codeOf(res)]).toEqual([409, "ALREADY_EXISTS"]);
    expect(detailsOf(res)).toContainEqual(
      expect.objectContaining({ issue: "already_member" }),
    );
  });

  it("at most 10 pending invitations per budget: the 11th is 422 LIMIT_REACHED", async () => {
    const w = await seedWorld();
    for (let i = 0; i < 10; i++)
      await dal().invitations.createBudgetInvitation(
        w.budget.scope,
        `pending-${i}@example.test`,
      );
    const res = await w.owner.client.post(
      `/budgets/${w.budget.id}/invitations`,
      { email: "eleventh@example.test" },
    );
    expect([res.status, codeOf(res)]).toEqual([422, "LIMIT_REACHED"]);
  });

  it("an invitation is accepted only by the account with that email; others get 404", async () => {
    const w = await seedWorld();
    const { invitation } = await dal().invitations.createBudgetInvitation(
      w.budget.scope,
      "someone-else@example.test",
    );
    for (const c of [w.member.client, w.outsider.client]) {
      const res = await c.post(`/me/invitations/${invitation.id}/accept`);
      expect([res.status, codeOf(res)], c.label).toEqual([404, "NOT_FOUND"]);
    }
  });

  it("the create call takes about the same fixed time whether or not the account exists (F-22 padding)", async () => {
    const w = await seedWorld();
    const existing = await createUser({ prefix: "known" });
    const time = async (email: string) => {
      const t = performance.now();
      const res = await w.owner.client.post(
        `/budgets/${w.budget.id}/invitations`,
        { email },
      );
      expect(res.status).toBe(201);
      return performance.now() - t;
    };
    const a = await time(existing.email);
    const b = await time("unknown-person@example.test");
    expect(a).toBeGreaterThanOrEqual(950);
    expect(b).toBeGreaterThanOrEqual(950);
    expect(Math.abs(a - b)).toBeLessThan(400);
  });
});
