// Second-factor checks (auth.md §5, §6, §8, §10, F-05). One function verifies
// a TOTP code, a passkey assertion or a recovery code for sign-in, re-auth or
// password reset, and applies the per-user MFA failure budget: 20 failed
// checks per rolling 24 h across all three; when it is exhausted every check
// answers 429 until the window ends, `mfa_locked` is recorded and the user is
// emailed once. Enrollment (TOTP confirm, passkey registration) is exempt.
import type { ChallengeBinding } from "@shoestring/db";
import type { RelyingParty } from "../auth/webauthn.ts";
import { verifyAssertion } from "../auth/webauthn.ts";
import { decryptTotpSecret, matchTotp } from "../auth/totp.ts";
import { matchRecoveryCode } from "../auth/recovery-codes.ts";
import type { AppDeps } from "../deps.ts";
import { ApiError } from "../errors.ts";
import { DAY } from "../http/rate-limit.ts";
import type { Reservation } from "../http/rate-limit.ts";

export const MFA_FAILURE_BUDGET = 20;

export type MfaProofInput =
  | { method: "totp"; code: string }
  | { method: "recovery_code"; code: string }
  | { method: "passkey"; assertion: unknown };

export type MfaContext =
  | { kind: "login"; sessionId: string }
  | { kind: "reauth"; sessionId: string }
  | { kind: "reset"; userTokenId: string };

export function relyingParty(deps: AppDeps): RelyingParty {
  return {
    id: deps.config.webauthn.rpId,
    name: deps.config.webauthn.rpName,
    origin: deps.config.appOrigin,
  };
}

function budgetKey(deps: AppDeps, userId: string) {
  return deps.throttles.key("mfa:user", userId);
}

/** 429 while the user's failure budget is exhausted (checked before any factor work). */
export async function assertMfaBudget(
  deps: AppDeps,
  userId: string,
): Promise<void> {
  if (
    (await deps.throttles.rollingCount(budgetKey(deps, userId), DAY)) >=
    MFA_FAILURE_BUDGET
  )
    throw new ApiError("RATE_LIMITED", { retryAfterSeconds: 3600 });
}

function binding(ctx: MfaContext): ChallengeBinding {
  if (ctx.kind === "reset")
    return { purpose: "password_reset", userTokenId: ctx.userTokenId };
  return {
    purpose: ctx.kind === "login" ? "mfa" : "reauth",
    sessionId: ctx.sessionId,
  };
}

async function check(
  deps: AppDeps,
  userId: string,
  proof: MfaProofInput,
  ctx: MfaContext,
): Promise<boolean> {
  const { dal } = deps;
  if (proof.method === "totp") {
    const row = await dal.mfa.getTotpSecret(userId, "confirmed");
    if (!row) return false;
    let secret: Buffer;
    try {
      secret = decryptTotpSecret(
        deps.config.keyring,
        row.keyId,
        userId,
        row.ciphertext,
      );
    } catch {
      return false;
    }
    const step = matchTotp(secret, proof.code, deps.clock.now());
    if (step === null) return false;
    return dal.mfa.useTotpStep(userId, step); // false = replayed
  }
  if (proof.method === "recovery_code") {
    const rows = await dal.mfa.listUnusedRecoveryCodes(userId);
    const id = matchRecoveryCode(deps.config.keyring, proof.code, rows);
    if (!id || !(await dal.mfa.useRecoveryCode(userId, id))) return false;
    await dal.securityEvents.recordSecurityEvent({
      type: "recovery_code_used",
      userId,
      sessionId: ctx.kind === "reset" ? null : ctx.sessionId,
    });
    const contact = await dal.users.getUserContact(userId);
    await deps.mailer.send(deps.notifications.recoveryCodeUsed(contact.email));
    return true;
  }
  const challenge = await dal.mfa.consumeWebAuthnChallenge(binding(ctx));
  if (challenge?.userId !== userId) return false;
  const creds = await dal.mfa.listPasskeyCredentials(userId);
  const r = await verifyAssertion(
    relyingParty(deps),
    proof.assertion,
    challenge.challenge,
    creds,
  );
  if (!r.ok) {
    if (r.reason === "counter_regression")
      await dal.securityEvents.recordSecurityEvent({
        type: "passkey_counter_regression",
        userId,
        sessionId: ctx.kind === "reset" ? null : ctx.sessionId,
      });
    return false;
  }
  await dal.mfa.recordPasskeyUse(userId, r.passkeyId, r.newCounter);
  return true;
}

/**
 * A per-session or per-token attempt counter around one factor check (F-45).
 * `reserve` runs BEFORE the check and throws when no attempt is left; after
 * the check exactly one of `failed` (the slot stays used) or `release` (the
 * slot is given back: success, a refusal before the check, or an error) runs.
 */
export interface AttemptGuard {
  reserve(): Promise<void>;
  failed(): Promise<void>;
  release(): Promise<void>;
}

export const NO_GUARD: AttemptGuard = {
  reserve: () => Promise.resolve(),
  failed: () => Promise.resolve(),
  release: () => Promise.resolve(),
};

/** Maps a DAL reservation refusal: the slot holder is gone, or all 5 slots are used or in flight. */
export function refusedAttempt(
  reason: "exhausted" | "invalid",
  gone: () => ApiError,
): ApiError {
  return reason === "invalid" ? gone() : new ApiError("RATE_LIMITED", { retryAfterSeconds: 1 });
}

/**
 * Throttle-table guard: counts the attempt first (atomic upsert), refuses
 * with 429 once over `limit` (refunding the refused attempt), refunds on success.
 */
export function throttleGuard(deps: AppDeps, scope: string, raw: string, limit: number, windowMs: number): AttemptGuard {
  let r: Reservation | null = null;
  return {
    async reserve() {
      r = await deps.throttles.reserve(deps.throttles.key(scope, raw), windowMs);
      if (r.count > limit) {
        await deps.throttles.release(r);
        r = null;
        throw new ApiError("RATE_LIMITED", { retryAfterSeconds: deps.throttles.retryAfter(windowMs) });
      }
    },
    failed: () => Promise.resolve(),
    async release() {
      if (r) await deps.throttles.release(r);
      r = null;
    },
  };
}

/**
 * Verifies a second factor, race-safe (F-05, F-45):
 * 1. the context guard reserves a per-session/per-token attempt;
 * 2. the per-user budget is charged FIRST (atomic), and an attempt that would
 *    exceed 20 per rolling 24 h is refused with 429 (and refunded, so refused
 *    attempts do not extend the lock);
 * 3. the factor is checked; success (or an error) refunds both reservations, failure keeps
 *    them, records `mfa_failed`, and the first failure that exhausts the
 *    budget records `mfa_locked` and emails the user once per window.
 * Throws 401 MFA_FAILED on a wrong, expired or replayed factor.
 */
export async function verifySecondFactor(
  deps: AppDeps,
  userId: string,
  proof: MfaProofInput,
  ctx: MfaContext,
  guard: AttemptGuard = NO_GUARD,
): Promise<void> {
  await guard.reserve();
  let budget: Reservation;
  try {
    budget = await deps.throttles.reserveRolling(budgetKey(deps, userId), DAY);
  } catch (e) {
    await guard.release(); // not an attempt
    throw e;
  }
  if (budget.count > MFA_FAILURE_BUDGET) {
    await deps.throttles.release(budget);
    await guard.release();
    throw new ApiError("RATE_LIMITED", { retryAfterSeconds: 3600 });
  }
  let ok: boolean;
  try {
    ok = await check(deps, userId, proof, ctx);
  } catch (e) {
    // An error is not a failed check: give both reservations back.
    await deps.throttles.release(budget);
    await guard.release();
    throw e;
  }
  if (ok) {
    await deps.throttles.release(budget);
    await guard.release();
    return;
  }
  await guard.failed();
  const sessionId = ctx.kind === "reset" ? null : ctx.sessionId;
  await deps.dal.securityEvents.recordSecurityEvent({ type: "mfa_failed", userId, sessionId });
  if (budget.count >= MFA_FAILURE_BUDGET) {
    // Exactly one notice per window, even when concurrent failures cross the line together.
    const notice = await deps.throttles.reserve(deps.throttles.key("mfa:locked_notice", userId), DAY);
    if (notice.count === 1) {
      await deps.dal.securityEvents.recordSecurityEvent({ type: "mfa_locked", userId, sessionId });
      const contact = await deps.dal.users.getUserContact(userId);
      await deps.mailer.send(deps.notifications.mfaLocked(contact.email));
    }
  }
  throw new ApiError("MFA_FAILED");
}
