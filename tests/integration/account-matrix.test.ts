// Account-level permission matrix (auth.md §13, first table), generated from
// x-session and x-pending-deletion-allowed. Session and pending-deletion checks
// run before body validation (errors.md steps 3-5), so these denials hold for
// any body; the request carries no body and placeholder path IDs.
import { describe, expect, it } from "vitest";
import { createUserWithTotp, startMfaSignIn } from "../support/auth.ts";
import { operations } from "../support/contract.ts";
import type { Operation } from "../support/contract.ts";
import { createUser } from "../support/factories.ts";
import type { ApiClient } from "../support/http.ts";
import { codeOf } from "../support/http.ts";
import { dal, testLogin } from "../support/hooks.ts";
import { invoke, pathFor, RECIPES } from "../support/recipes.ts";
import { persona, sessionIdOf, seedWorld } from "../support/world.ts";

const PLACEHOLDER = "0190a0a0-0000-7000-8000-000000000000";
function placeholderPath(op: Operation): string {
  return pathFor(
    op,
    Object.fromEntries(
      op.pathParams.map((p) => [p, p === "month" ? "2026-11" : PLACEHOLDER]),
    ),
  );
}
async function hit(op: Operation, client: ApiClient) {
  return client.request(op.method, placeholderPath(op));
}

const activeOps = operations.filter((o) => o.session === "active");
const pdBlocked = activeOps.filter((o) => !o.pendingDeletionAllowed);

describe("MFA-pending session (auth.md §5 step 3)", () => {
  it.each(activeOps.map((o) => [o.operationId, o] as const))(
    "%s → 401 MFA_REQUIRED",
    async (_id, op) => {
      const u = await createUserWithTotp();
      const res = await hit(op, await startMfaSignIn(u));
      expect([res.status, codeOf(res)], res.describe).toEqual([
        401,
        "MFA_REQUIRED",
      ]);
    },
  );

  it("GET /auth/session answers mfa_required with the allowed methods", async () => {
    const u = await createUserWithTotp();
    const res = await (
      await startMfaSignIn(u)
    ).get<{ state: string; mfaMethods: string[] }>("/auth/session");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("mfa_required");
    expect(res.body.mfaMethods).toEqual(
      expect.arrayContaining(["totp", "recovery_code"]),
    );
  });

  it("POST /auth/webauthn/challenge with purpose reauth from an MFA-pending session → 403 FORBIDDEN", async () => {
    const u = await createUserWithTotp();
    const res = await (
      await startMfaSignIn(u)
    ).post("/auth/webauthn/challenge", { purpose: "reauth" });
    expect([res.status, codeOf(res)]).toEqual([403, "FORBIDDEN"]);
  });
});

describe("fully signed-in session on MFA-only endpoints", () => {
  it.each(
    operations
      .filter((o) => o.session === "mfa_pending")
      .map((o) => [o.operationId, o] as const),
  )("%s from an active session → 403 FORBIDDEN", async (_id, op) => {
    const p = await persona("active");
    const res = await p.client.request(op.method, placeholderPath(op), {
      body: { method: "totp", code: "000000" },
    });
    expect([res.status, codeOf(res)], res.describe).toEqual([403, "FORBIDDEN"]);
  });

  it("POST /auth/webauthn/challenge with purpose mfa from an active session → 403 FORBIDDEN", async () => {
    const p = await persona("active");
    const res = await p.client.post("/auth/webauthn/challenge", {
      purpose: "mfa",
    });
    expect([res.status, codeOf(res)]).toEqual([403, "FORBIDDEN"]);
  });
});

describe("account pending deletion (auth.md §11)", () => {
  async function pendingDeletion() {
    const user = await createUser({ prefix: "leaving" });
    await dal().users.requestAccountDeletion(user.userId);
    return { user, client: await testLogin(user.email, "pending-deletion") };
  }

  it.each(pdBlocked.map((o) => [o.operationId, o] as const))(
    "%s → 403 ACCOUNT_PENDING_DELETION",
    async (_id, op) => {
      const { client } = await pendingDeletion();
      const res = await hit(op, client);
      expect([res.status, codeOf(res)], res.describe).toEqual([
        403,
        "ACCOUNT_PENDING_DELETION",
      ]);
    },
  );

  it.each([
    "getAuthSession",
    "getMe",
    "exportMyData",
    "reauthenticate",
    "logout",
  ])(
    "%s (x-pending-deletion-allowed) works for an account pending deletion",
    async (opId) => {
      const { user, client } = await pendingDeletion();
      const w = await seedWorld();
      const call = await RECIPES[opId]!.prepare(w, { user, client });
      const res = await invoke(opId, call, client);
      expect(res.status, res.describe).toBe(RECIPES[opId]!.status);
    },
  );

  it("GET /me shows the deletion status and DELETE /me/deletion restores the account", async () => {
    const { client } = await pendingDeletion();
    const me = await client.get<{ deletion: { purgeAfter: string } | null }>(
      "/me",
    );
    expect(me.body.deletion).not.toBeNull();
    const cancel = await client.delete<{ deletion: null }>("/me/deletion");
    expect(cancel.status).toBe(200);
    expect(cancel.body.deletion).toBeNull();
    expect((await client.get("/budgets")).status).toBe(200);
  });

  it("DELETE /me/deletion for an account that is not pending deletion → 404 NOT_FOUND", async () => {
    const p = await persona("active");
    const res = await p.client.delete("/me/deletion");
    expect([res.status, codeOf(res)]).toEqual([404, "NOT_FOUND"]);
  });

  it("an owner of a shared budget cannot request deletion (409 OWNS_SHARED_BUDGET)", async () => {
    const w = await seedWorld();
    const res = await w.owner.client.post("/me/deletion");
    expect([res.status, codeOf(res)]).toEqual([409, "OWNS_SHARED_BUDGET"]);
  });

  it("requesting deletion revokes every session, including the caller's", async () => {
    const p = await persona("solo");
    const other = await testLogin(p.user.email, "other-device");
    expect((await p.client.post("/me/deletion")).status).toBe(202);
    for (const c of [p.client, other]) {
      const res = await c.get("/me");
      expect([res.status, codeOf(res)], c.label).toEqual([
        401,
        "UNAUTHENTICATED",
      ]);
    }
  });
});

describe("own sessions only (auth.md §13)", () => {
  it("DELETE /me/sessions/{id} of another user's session → 404 NOT_FOUND, and that session survives", async () => {
    const a = await persona("alice");
    const b = await persona("bob");
    const res = await a.client.delete(
      `/me/sessions/${await sessionIdOf(b.client)}`,
    );
    expect([res.status, codeOf(res)]).toEqual([404, "NOT_FOUND"]);
    expect((await b.client.get("/me")).status).toBe(200);
  });

  it("GET /me/sessions lists only the caller's sessions and marks the current one", async () => {
    const a = await persona("alice");
    await testLogin(a.user.email, "alice-phone");
    await persona("bob");
    const res = await a.client.get<{
      items: { id: string; current: boolean }[];
    }>("/me/sessions");
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.filter((s) => s.current).map((s) => s.id)).toEqual([
      await sessionIdOf(a.client),
    ]);
  });
});
