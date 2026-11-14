// F-45: second-factor attempts on a pending session or a reset token are
// reserved atomically before the factor check, so parallel guesses cannot
// overrun the 5-attempt limit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MINUTE_MS } from "../context.ts";
import { createDal } from "../dal.ts";
import type { Dal } from "../dal.ts";
import type { MfaAttemptReservation } from "../records.ts";
import {
  csrf,
  fakePasswordHash,
  hash32,
  newUser,
} from "../test-support/fixtures.ts";
import { START, useTestDb } from "../test-support/harness.ts";

const t = useTestDb();
const PARALLEL = 50;

// A second Dal on the same clone with enough connections that the 50 calls
// really run concurrently (the default pool has 5).
let wide: Dal;
beforeAll(() => {
  wide = createDal({
    connectionString: t.appUrl,
    clock: t.clock.clock,
    poolMax: 25,
  });
});
afterAll(async () => {
  await wide.close();
});

const pendingSession = async (userId: string) =>
  t.dal.sessions.createSession({
    userId,
    tokenHash: hash32(),
    csrfToken: csrf(),
    status: "mfa_pending",
    deviceBrowser: "safari",
    deviceOs: "ios",
  });

const counter = async (table: "sessions" | "user_tokens", id: string) =>
  (
    await t.admin.query<{ n: number }>(
      `select mfa_failed_attempts as n from ${table} where id = $1`,
      [id],
    )
  ).rows[0]?.n;

function tally(results: MfaAttemptReservation[]) {
  const granted = results.filter((r) => r.granted);
  return {
    attempts: granted.map((r) => r.attempt).sort((a, b) => a - b),
    exhausted: results.filter((r) => !r.granted && r.reason === "exhausted")
      .length,
  };
}

describe("pending session attempts (F-45)", () => {
  it(`${PARALLEL} parallel reservations grant exactly 5; the 5 failures delete the session once`, async () => {
    const { userId } = await newUser(t.dal);
    const p = await pendingSession(userId);
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        wide.sessions.reserveSessionMfaAttempt(p.id),
      ),
    );
    expect(tally(results)).toEqual({
      attempts: [1, 2, 3, 4, 5],
      exhausted: PARALLEL - 5,
    });
    expect(await counter("sessions", p.id)).toBe(5);

    const fails = await Promise.all(
      Array.from({ length: 5 }, () =>
        wide.sessions.failSessionMfaAttempt(p.id),
      ),
    );
    expect(fails.filter((f) => f.deleted)).toHaveLength(1);
    expect(fails.every((f) => !f.open)).toBe(true);
    expect(await counter("sessions", p.id)).toBeUndefined();
    expect(await t.dal.sessions.reserveSessionMfaAttempt(p.id)).toEqual({
      granted: false,
      reason: "invalid",
    });
  });

  it("the 5th attempt can still succeed, and completion needs no release", async () => {
    const { userId } = await newUser(t.dal);
    const p = await pendingSession(userId);
    for (let i = 0; i < 4; i++) {
      await t.dal.sessions.reserveSessionMfaAttempt(p.id);
      await t.dal.sessions.failSessionMfaAttempt(p.id);
    }
    expect(await t.dal.sessions.reserveSessionMfaAttempt(p.id)).toEqual({
      granted: true,
      attempt: 5,
    });
    const active = await t.dal.sessions.completeMfaSession(p.id, {
      tokenHash: hash32(),
      csrfToken: csrf(),
    });
    expect(active).toMatchObject({ status: "active", userId });
    // A late failure from the same burst must not touch the new session.
    expect(await t.dal.sessions.failSessionMfaAttempt(p.id)).toEqual({
      attempts: 0,
      deleted: false,
      open: false,
    });
    expect(await counter("sessions", active?.id ?? "")).toBe(0);
  });

  it("exhausted while attempts are in flight; release gives one slot back, never below 0", async () => {
    const { userId } = await newUser(t.dal);
    const p = await pendingSession(userId);
    await t.dal.sessions.releaseSessionMfaAttempt(p.id);
    expect(await counter("sessions", p.id)).toBe(0);
    for (let i = 0; i < 5; i++)
      await t.dal.sessions.reserveSessionMfaAttempt(p.id);
    expect(await t.dal.sessions.reserveSessionMfaAttempt(p.id)).toEqual({
      granted: false,
      reason: "exhausted",
    });
    // A failure while other slots are unresolved still ends the session at 5.
    await t.dal.sessions.releaseSessionMfaAttempt(p.id);
    expect(await t.dal.sessions.reserveSessionMfaAttempt(p.id)).toEqual({
      granted: true,
      attempt: 5,
    });
    expect((await t.dal.sessions.failSessionMfaAttempt(p.id)).deleted).toBe(
      true,
    );
  });

  it("only unexpired mfa_pending sessions get slots", async () => {
    const { userId } = await newUser(t.dal);
    const active = await t.dal.sessions.createSession({
      userId,
      tokenHash: hash32(),
      csrfToken: csrf(),
      status: "active",
      deviceBrowser: "safari",
      deviceOs: "ios",
    });
    expect(await t.dal.sessions.reserveSessionMfaAttempt(active.id)).toEqual({
      granted: false,
      reason: "invalid",
    });
    expect(await t.dal.sessions.failSessionMfaAttempt(active.id)).toEqual({
      attempts: 0,
      deleted: false,
      open: false,
    });
    expect(await counter("sessions", active.id)).toBe(0);
    expect(await t.dal.sessions.reserveSessionMfaAttempt("not-a-uuid")).toEqual(
      { granted: false, reason: "invalid" },
    );
    const p = await pendingSession(userId);
    t.clock.advance(10 * MINUTE_MS);
    expect(await t.dal.sessions.reserveSessionMfaAttempt(p.id)).toEqual({
      granted: false,
      reason: "invalid",
    });
    t.clock.set(START);
  });

  it("refuses to run inside dal.transaction (a rollback would refund the slot)", async () => {
    const { userId } = await newUser(t.dal);
    const p = await pendingSession(userId);
    await expect(
      t.dal.transaction((tx) => tx.sessions.reserveSessionMfaAttempt(p.id)),
    ).rejects.toThrow(TypeError);
    await expect(
      t.dal.transaction((tx) => tx.sessions.failSessionMfaAttempt(p.id)),
    ).rejects.toThrow(TypeError);
    expect(await counter("sessions", p.id)).toBe(0);
  });
});

describe("password-reset token attempts (F-45)", () => {
  it(`${PARALLEL} parallel reservations grant exactly 5; the 5 failures invalidate the token once`, async () => {
    const { userId } = await newUser(t.dal);
    const tokenHash = hash32();
    const { tokenId } = await t.dal.tokens.issuePasswordResetToken(
      userId,
      tokenHash,
    );
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        wide.tokens.reserveTokenMfaAttempt(tokenId),
      ),
    );
    expect(tally(results)).toEqual({
      attempts: [1, 2, 3, 4, 5],
      exhausted: PARALLEL - 5,
    });
    expect(await counter("user_tokens", tokenId)).toBe(5);

    const fails = await Promise.all(
      Array.from({ length: 5 }, () => wide.tokens.failTokenMfaAttempt(tokenId)),
    );
    expect(fails.filter((f) => f.invalidated)).toHaveLength(1);
    expect(fails.every((f) => !f.open)).toBe(true);
    expect(
      await t.dal.tokens.findValidUserToken(tokenHash, "password_reset"),
    ).toBeNull();
    await expect(
      t.dal.tokens.completePasswordReset(tokenHash, fakePasswordHash()),
    ).rejects.toMatchObject({ code: "TOKEN_INVALID" });
  });

  it("the 5th attempt can still complete the reset; release gives a slot back", async () => {
    const { userId } = await newUser(t.dal);
    const tokenHash = hash32();
    const { tokenId } = await t.dal.tokens.issuePasswordResetToken(
      userId,
      tokenHash,
    );
    await t.dal.tokens.releaseTokenMfaAttempt(tokenId);
    expect(await counter("user_tokens", tokenId)).toBe(0);
    for (let i = 0; i < 4; i++) {
      await t.dal.tokens.reserveTokenMfaAttempt(tokenId);
      await t.dal.tokens.failTokenMfaAttempt(tokenId);
    }
    await t.dal.tokens.reserveTokenMfaAttempt(tokenId);
    expect(await t.dal.tokens.reserveTokenMfaAttempt(tokenId)).toEqual({
      granted: false,
      reason: "exhausted",
    });
    await t.dal.tokens.releaseTokenMfaAttempt(tokenId); // e.g. the per-user budget said 429
    expect(await t.dal.tokens.reserveTokenMfaAttempt(tokenId)).toEqual({
      granted: true,
      attempt: 5,
    });
    expect(
      await t.dal.tokens.completePasswordReset(tokenHash, fakePasswordHash()),
    ).toMatchObject({ userId });
    expect(await t.dal.tokens.reserveTokenMfaAttempt(tokenId)).toEqual({
      granted: false,
      reason: "invalid",
    });
    expect(await t.dal.tokens.failTokenMfaAttempt(tokenId)).toEqual({
      attempts: 0,
      invalidated: false,
      open: false,
    });
    // A used token is kept (not deleted) by a late failure.
    expect(await counter("user_tokens", tokenId)).toBe(5);
  });

  it("expired tokens get no slots; refuses to run inside dal.transaction", async () => {
    const { userId } = await newUser(t.dal);
    const { tokenId } = await t.dal.tokens.issuePasswordResetToken(
      userId,
      hash32(),
    );
    await expect(
      t.dal.transaction((tx) => tx.tokens.reserveTokenMfaAttempt(tokenId)),
    ).rejects.toThrow(TypeError);
    await expect(
      t.dal.transaction((tx) => tx.tokens.failTokenMfaAttempt(tokenId)),
    ).rejects.toThrow(TypeError);
    expect(await counter("user_tokens", tokenId)).toBe(0);
    t.clock.advance(30 * MINUTE_MS);
    expect(await t.dal.tokens.reserveTokenMfaAttempt(tokenId)).toEqual({
      granted: false,
      reason: "invalid",
    });
    t.clock.set(START);
  });
});
