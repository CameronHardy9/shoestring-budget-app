// F-33 / F-01 regressions through the API (auth.md §9 "Regression tests"):
//   1. A → B confirmed; B → C within 24 h is 429 with Retry-After; cancel_A
//      reverts to A, revokes every session and emails both A and B.
//   2. The chain (seeded, because the API refuses to build it): email B with
//      an open cancel_A, a pending B → C and a newer cancel_B. cancel_B cancels
//      B → C and leaves cancel_A open; cancel_A then reverts to A and deletes
//      every cancel token created after it.
// POST /me/email-change answers at a fixed 1 s (F-22), so calls are few.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { adminQuery } from "../../support/db-locks.ts";
import { createUser, uniqueEmail } from "../../support/factories.ts";
import { ApiClient, codeOf, detailsOf } from "../../support/http.ts";
import {
  advanceClock,
  emails,
  lastEmail,
  MINUTE,
  now,
  testLogin,
  tokenFromLink,
} from "../../support/hooks.ts";
import { oneTimeToken, persona, sessionIdOf } from "../../support/world.ts";

const anon = () => new ApiClient("anonymous");

async function emailOf(address: string): Promise<string> {
  const me = await (await testLogin(address)).get<{ email: string }>("/me");
  return me.body.email;
}

/** A → B requested and confirmed through the API; returns cancel_A and the reissued cancel link. */
async function changeAndConfirm() {
  const user = await createUser({ prefix: "alice" });
  const a = user.email;
  const b = uniqueEmail("bravo");
  const client = await testLogin(a, "alice");
  const otherDevice = await testLogin(a, "alice-phone");
  const req = await client.post("/me/email-change", { newEmail: b });
  expect(req.status).toBe(202);
  const confirm = await lastEmail(b, "email_change_confirm");
  const notice = await lastEmail(a, "email_change_notice");
  const cancelA = tokenFromLink(notice.links[0]!);
  expect(
    (
      await client.post("/auth/email-change/confirm", {
        token: tokenFromLink(confirm.links[0]!),
      })
    ).status,
  ).toBe(204);
  const changedOld = await lastEmail(a, "email_changed");
  const changedNew = await lastEmail(b, "email_changed");
  expect(changedNew.links).toEqual([]);
  const reissued = tokenFromLink(changedOld.links[0]!);
  return { user, a, b, client, otherDevice, cancelA, reissued };
}

describe("F-33 regression 1: A → B, then B → C refused, then cancel_A reverts", () => {
  it("one change per 24 h (429 + Retry-After), and the old mailbox's link reverts, revokes every session and mails both", async () => {
    const { a, b, client, otherDevice, cancelA } = await changeAndConfirm();
    // Confirm revoked every session except the confirming one.
    expect(codeOf(await otherDevice.get("/me"))).toBe("UNAUTHENTICATED");
    expect((await client.get<{ email: string }>("/me")).body.email).toBe(b);

    const second = await client.post("/me/email-change", {
      newEmail: uniqueEmail("charlie"),
    });
    expect([second.status, codeOf(second)]).toEqual([429, "RATE_LIMITED"]);
    const retry = Number(second.header("retry-after"));
    expect(retry).toBeGreaterThan(23 * 3600);
    expect(retry).toBeLessThanOrEqual(24 * 3600);

    expect(
      (await anon().post("/auth/email-change/cancel", { token: cancelA }))
        .status,
    ).toBe(204);
    expect(codeOf(await client.get("/me"))).toBe("UNAUTHENTICATED");
    expect(await emailOf(a)).toBe(a);
    for (const address of [a, b]) {
      const mail = await lastEmail(address, "email_change_cancelled");
      expect(
        mail.links.map((l) => new URL(l).pathname + new URL(l).hash),
      ).toEqual(["/reset-password"]);
    }
    expect(
      codeOf(
        await anon().post("/auth/email-change/cancel", { token: cancelA }),
      ),
    ).toBe("TOKEN_INVALID");
  });

  it("after the 24 h window the user may change the email again", async () => {
    const { b } = await changeAndConfirm();
    await advanceClock(24 * 60 * MINUTE + 1_000);
    // A fresh sign-in (the old re-auth window closed long ago).
    const fresh = await testLogin(b);
    const res = await fresh.post("/me/email-change", {
      newEmail: uniqueEmail("later"),
    });
    expect(res.status).toBe(202);
  });
});

describe("F-33 regression 2: the cancel-token chain (seeded through the database)", () => {
  it("cancel_B cancels B → C and keeps cancel_A; cancel_A then reverts to A and deletes later cancel tokens", async () => {
    const { user, a, b, client, cancelA, reissued } = await changeAndConfirm();
    const c = uniqueEmail("charlie");
    // The API refuses a second change within 24 h, so the pending B → C and its
    // newer cancel_B are inserted directly (auth.md §9 regression test 2).
    await advanceClock(MINUTE);
    const changeC = oneTimeToken();
    const cancelB = oneTimeToken();
    const at = now();
    const expires = new Date(at.getTime() + 24 * 60 * MINUTE);
    await adminQuery(
      `insert into user_tokens (id, user_id, purpose, token_hash, email, requested_by_session_id, created_at, updated_at, expires_at)
       values (gen_random_uuid(), $1, 'email_change', $2, $3, $4, $5, $5, $6),
              (gen_random_uuid(), $1, 'email_change_cancel', $7, $8, null, $5, $5, $6)`,
      [
        user.userId,
        changeC.hash,
        c,
        await sessionIdOf(client),
        at,
        expires,
        cancelB.hash,
        b,
      ],
    );

    expect(
      (await anon().post("/auth/email-change/cancel", { token: cancelB.token }))
        .status,
    ).toBe(204);
    expect(await emailOf(b)).toBe(b); // cancelled: email stays B
    // The pending B → C died with it.
    const later = await testLogin(b);
    expect(
      codeOf(
        await later.post("/auth/email-change/confirm", {
          token: changeC.token,
        }),
      ),
    ).toBe("TOKEN_INVALID");

    // cancel_A is still open and wins: revert to A.
    expect(
      (await anon().post("/auth/email-change/cancel", { token: cancelA }))
        .status,
    ).toBe(204);
    expect(await emailOf(a)).toBe(a);
    expect(codeOf(await later.get("/me"))).toBe("UNAUTHENTICATED");
    // Every cancel token created after cancel_A is gone (the reissued one, cancel_B).
    expect(
      codeOf(
        await anon().post("/auth/email-change/cancel", { token: reissued }),
      ),
    ).toBe("TOKEN_INVALID");
    expect(
      codeOf(
        await anon().post("/auth/email-change/cancel", {
          token: cancelB.token,
        }),
      ),
    ).toBe("TOKEN_INVALID");
  });

  it("an attacker's revocation events (password change, revoke-others) never delete the victim's cancel link (F-01)", async () => {
    const { client, a, cancelA } = await changeAndConfirm();
    expect(
      (
        await client.post("/me/password", {
          newPassword: `pw-${randomUUID()}`,
        })
      ).status,
    ).toBe(204);
    expect((await client.post("/me/sessions/revoke-others")).status).toBe(204);
    expect(
      (await anon().post("/auth/email-change/cancel", { token: cancelA }))
        .status,
    ).toBe(204);
    expect(await emailOf(a)).toBe(a);
  });
});

describe("email change request and confirm rules (auth.md §9)", () => {
  it("a taken address answers the same 202, mails only that address (email_change_exists) and creates no tokens", async () => {
    const p = await persona("asker");
    const taken = await createUser({ prefix: "taken" });
    const res = await p.client.post("/me/email-change", {
      newEmail: taken.email,
    });
    expect(res.status).toBe(202);
    expect((await emails(taken.email)).map((e) => e.kind)).toEqual([
      "email_change_exists",
    ]);
    expect(await emails(p.user.email)).toEqual([]);
    // No cancel token was created, so a real change is still allowed.
    expect(
      (
        await p.client.post("/me/email-change", {
          newEmail: uniqueEmail("free"),
        })
      ).status,
    ).toBe(202);
  });

  it("the current address is 400 (newEmail, invalid_value); stale re-auth is 403 REAUTH_REQUIRED", async () => {
    const p = await persona("asker");
    const same = await p.client.post("/me/email-change", {
      newEmail: p.user.email.toUpperCase(),
    });
    expect([same.status, codeOf(same)]).toEqual([400, "VALIDATION_FAILED"]);
    expect(detailsOf(same)).toContainEqual(
      expect.objectContaining({ field: "newEmail", issue: "invalid_value" }),
    );
    await advanceClock(11 * MINUTE);
    expect(
      codeOf(
        await p.client.post("/me/email-change", { newEmail: uniqueEmail("x") }),
      ),
    ).toBe("REAUTH_REQUIRED");
  });

  it("confirm needs an active session of the same user, and dies with the requesting session", async () => {
    const p = await persona("asker");
    const b = uniqueEmail("bravo");
    await p.client.post("/me/email-change", { newEmail: b });
    const token = tokenFromLink(
      (await lastEmail(b, "email_change_confirm")).links[0]!,
    );
    const stranger = await persona("stranger");
    expect(
      codeOf(
        await stranger.client.post("/auth/email-change/confirm", { token }),
      ),
    ).toBe("TOKEN_INVALID");
    expect(
      codeOf(await anon().post("/auth/email-change/confirm", { token })),
    ).toBe("UNAUTHENTICATED");
    // Same user, another device: fine in principle, but revoking the requesting session kills the token.
    const other = await testLogin(p.user.email, "asker-phone");
    expect(
      (await other.delete(`/me/sessions/${await sessionIdOf(p.client)}`))
        .status,
    ).toBe(204);
    expect(
      codeOf(await other.post("/auth/email-change/confirm", { token })),
    ).toBe("TOKEN_INVALID");
  });
});
