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
 * Verifies a second factor. Throws 429 RATE_LIMITED when the budget is spent,
 * 401 MFA_FAILED on a wrong/expired/replayed factor (after counting it).
 */
export async function verifySecondFactor(
  deps: AppDeps,
  userId: string,
  proof: MfaProofInput,
  ctx: MfaContext,
): Promise<void> {
  await assertMfaBudget(deps, userId);
  if (await check(deps, userId, proof, ctx)) return;
  const sessionId = ctx.kind === "reset" ? null : ctx.sessionId;
  await deps.dal.securityEvents.recordSecurityEvent({
    type: "mfa_failed",
    userId,
    sessionId,
  });
  const failures = await deps.throttles.rollingHit(
    budgetKey(deps, userId),
    DAY,
  );
  if (failures === MFA_FAILURE_BUDGET) {
    await deps.dal.securityEvents.recordSecurityEvent({
      type: "mfa_locked",
      userId,
      sessionId,
    });
    const contact = await deps.dal.users.getUserContact(userId);
    await deps.mailer.send(deps.notifications.mfaLocked(contact.email));
  }
  throw new ApiError("MFA_FAILED");
}
