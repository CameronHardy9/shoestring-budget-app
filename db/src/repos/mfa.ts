// MFA storage (auth.md §6, F-04, F-05, F-24, F-38). Encryption, HMACs and
// constant-time comparison happen in the backend; the DAL stores ciphertext,
// key IDs and hashes, enforces single use and replay protection atomically,
// and applies the F-01 rule (MFA changes delete open one-time tokens).
import { sql } from "kysely";
import type { Ctx } from "../context.ts";
import { MINUTE_MS, withTx } from "../context.ts";
import {
  DalError,
  isUniqueViolation,
  limitReached,
  notFound,
} from "../errors.ts";
import type { MfaSummaryRecord } from "../records.ts";
import type { WebAuthnChallengePurpose } from "../schema.ts";
import { isUuid } from "../scope.ts";
import { LIMITS, deleteOpenUserTokens, lockUser } from "./common.ts";

const TOTP_SETUP_TTL_MS = 15 * MINUTE_MS;
const CHALLENGE_TTL_MS = 5 * MINUTE_MS;
const KEY_ID_RE = /^k[0-9]{1,4}$/;

export interface RecoveryCodeHashes {
  /** APP_KEYRING key ID used for the HMACs (always the current key). */
  keyId: string;
  /** 10 HMAC-SHA-256 values (32 bytes each). */
  hashes: Buffer[];
}

async function activeFactorCount(
  ctx: Ctx,
  userId: string,
): Promise<{ totp: boolean; passkeys: number }> {
  const totp = await ctx.db
    .selectFrom("totp_credentials")
    .select("user_id")
    .where("user_id", "=", userId)
    .where("confirmed_at", "is not", null)
    .executeTakeFirst();
  const pk = await ctx.db
    .selectFrom("webauthn_credentials")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("user_id", "=", userId)
    .executeTakeFirstOrThrow();
  return { totp: totp !== undefined, passkeys: pk.n };
}

async function insertRecoveryCodes(
  ctx: Ctx,
  userId: string,
  codes: RecoveryCodeHashes,
): Promise<void> {
  if (!KEY_ID_RE.test(codes.keyId))
    throw new TypeError("invalid keyring key ID");
  const now = ctx.clock();
  await ctx.db
    .deleteFrom("recovery_codes")
    .where("user_id", "=", userId)
    .execute();
  if (codes.hashes.length === 0) return;
  await ctx.db
    .insertInto("recovery_codes")
    .values(
      codes.hashes.map((h) => ({
        id: ctx.newId(),
        user_id: userId,
        key_id: codes.keyId,
        code_hash: h,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
}

/** Me.mfa: MFA is enabled iff at least one factor (confirmed TOTP or a passkey) is active. */
export async function getMfaSummary(
  ctx: Ctx,
  userId: string,
): Promise<MfaSummaryRecord> {
  const { totp, passkeys } = await activeFactorCount(ctx, userId);
  const codes = await ctx.db
    .selectFrom("recovery_codes")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("user_id", "=", userId)
    .where("used_at", "is", null)
    .executeTakeFirstOrThrow();
  return {
    enabled: totp || passkeys > 0,
    totp,
    passkeyCount: passkeys,
    recoveryCodesRemaining: codes.n,
  };
}

export interface PasskeySummary {
  id: string;
  /** PII (low): the user's label */
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface MfaDetailRecord extends MfaSummaryRecord {
  /** When TOTP was confirmed (MfaDetail.totp.confirmedAt); null iff `totp` is false. */
  totpConfirmedAt: Date | null;
  passkeys: PasskeySummary[];
}

/**
 * GET /me/mfa: the summary plus the TOTP confirmation time and the passkey
 * list. One snapshot (REPEATABLE READ, read only), so `totp`/`totpConfirmedAt`,
 * `passkeyCount`/`passkeys` and `enabled` always agree even while a factor is
 * being added or removed concurrently.
 */
export async function getMfaDetail(
  ctx: Ctx,
  userId: string,
): Promise<MfaDetailRecord> {
  const read = async (c: Ctx): Promise<MfaDetailRecord> => {
    const summary = await getMfaSummary(c, userId);
    const totp = await c.db
      .selectFrom("totp_credentials")
      .select("confirmed_at")
      .where("user_id", "=", userId)
      .where("confirmed_at", "is not", null)
      .executeTakeFirst();
    const rows = await c.db
      .selectFrom("webauthn_credentials")
      .select(["id", "name", "created_at", "last_used_at"])
      .where("user_id", "=", userId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return {
      ...summary,
      totpConfirmedAt: totp?.confirmed_at ?? null,
      passkeys: rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
      })),
    };
  };
  if (ctx.db.isTransaction) return read(ctx);
  return ctx.db
    .transaction()
    .setIsolationLevel("repeatable read")
    .setAccessMode("read only")
    .execute((trx) => read({ ...ctx, db: trx }));
}

// ------------------------------------------------------------------ TOTP

/** POST /me/mfa/totp: stores an unconfirmed secret (replaces an unfinished setup). ALREADY_EXISTS if TOTP is on. */
export async function beginTotpSetup(
  ctx: Ctx,
  userId: string,
  secret: { keyId: string; ciphertext: Buffer },
): Promise<void> {
  if (!KEY_ID_RE.test(secret.keyId))
    throw new TypeError("invalid keyring key ID");
  await withTx(ctx, async (tx) => {
    await lockUser(tx, userId);
    const existing = await tx.db
      .selectFrom("totp_credentials")
      .select("confirmed_at")
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (existing?.confirmed_at) throw new DalError("ALREADY_EXISTS");
    const now = tx.clock();
    await tx.db
      .deleteFrom("totp_credentials")
      .where("user_id", "=", userId)
      .execute();
    await tx.db
      .insertInto("totp_credentials")
      .values({
        user_id: userId,
        key_id: secret.keyId,
        secret_ciphertext: secret.ciphertext,
        created_at: now,
        updated_at: now,
      })
      .execute();
  });
}

export interface TotpSecretRecord {
  keyId: string;
  /** Secret: nonce || ciphertext || tag, AAD = user ID. */
  ciphertext: Buffer;
  confirmed: boolean;
  lastUsedStep: number | null;
}

/**
 * The stored TOTP secret: `confirmed` (an active factor) or a setup in
 * progress younger than 15 minutes. Null otherwise.
 */
export async function getTotpSecret(
  ctx: Ctx,
  userId: string,
  which: "confirmed" | "pending_setup",
): Promise<TotpSecretRecord | null> {
  if (!isUuid(userId)) return null;
  let q = ctx.db
    .selectFrom("totp_credentials")
    .select(["key_id", "secret_ciphertext", "confirmed_at", "last_used_step"])
    .where("user_id", "=", userId);
  q =
    which === "confirmed"
      ? q.where("confirmed_at", "is not", null)
      : q
          .where("confirmed_at", "is", null)
          .where(
            "created_at",
            ">",
            new Date(ctx.clock().getTime() - TOTP_SETUP_TTL_MS),
          );
  const row = await q.executeTakeFirst();
  if (!row) return null;
  return {
    keyId: row.key_id,
    ciphertext: row.secret_ciphertext,
    confirmed: row.confirmed_at !== null,
    lastUsedStep: row.last_used_step,
  };
}

/**
 * POST /me/mfa/totp/confirm (after the backend verified the code). Marks the
 * setup confirmed with `step` as the last used step, stores `recoveryCodes`
 * only if this is the user's first factor, and deletes open one-time tokens.
 * NOT_FOUND if there is no setup in progress.
 */
export async function confirmTotpSetup(
  ctx: Ctx,
  userId: string,
  input: { step: number; recoveryCodes: RecoveryCodeHashes },
): Promise<{ recoveryCodesCreated: boolean }> {
  return withTx(ctx, async (tx) => {
    await lockUser(tx, userId);
    const before = await activeFactorCount(tx, userId);
    const now = tx.clock();
    const res = await tx.db
      .updateTable("totp_credentials")
      .set({ confirmed_at: now, last_used_step: input.step, updated_at: now })
      .where("user_id", "=", userId)
      .where("confirmed_at", "is", null)
      .where("created_at", ">", new Date(now.getTime() - TOTP_SETUP_TTL_MS))
      .executeTakeFirst();
    if (res.numUpdatedRows === 0n) throw notFound();
    const first = !before.totp && before.passkeys === 0;
    if (first) await insertRecoveryCodes(tx, userId, input.recoveryCodes);
    await deleteOpenUserTokens(tx, userId);
    return { recoveryCodesCreated: first };
  });
}

/**
 * Replay protection: records `step` as used if it is greater than the last
 * used step. False means the code was already used (reject it).
 */
export async function useTotpStep(
  ctx: Ctx,
  userId: string,
  step: number,
): Promise<boolean> {
  if (!isUuid(userId)) return false;
  const row = await ctx.db
    .updateTable("totp_credentials")
    .set({ last_used_step: step, updated_at: ctx.clock() })
    .where("user_id", "=", userId)
    .where("confirmed_at", "is not", null)
    .where((eb) =>
      eb.or([
        eb("last_used_step", "is", null),
        eb("last_used_step", "<", step),
      ]),
    )
    .returning("user_id")
    .executeTakeFirst();
  return row !== undefined;
}

/** After removing a factor: no factor left -> recovery codes go too. Deletes open tokens. */
async function afterFactorRemoved(
  ctx: Ctx,
  userId: string,
): Promise<{ mfaDisabled: boolean }> {
  const after = await activeFactorCount(ctx, userId);
  const disabled = !after.totp && after.passkeys === 0;
  if (disabled)
    await ctx.db
      .deleteFrom("recovery_codes")
      .where("user_id", "=", userId)
      .execute();
  await deleteOpenUserTokens(ctx, userId);
  return { mfaDisabled: disabled };
}

/** DELETE /me/mfa/totp. NOT_FOUND if TOTP is not enabled. */
export async function removeTotp(
  ctx: Ctx,
  userId: string,
): Promise<{ mfaDisabled: boolean }> {
  return withTx(ctx, async (tx) => {
    await lockUser(tx, userId);
    const res = await tx.db
      .deleteFrom("totp_credentials")
      .where("user_id", "=", userId)
      .where("confirmed_at", "is not", null)
      .executeTakeFirst();
    if (res.numDeletedRows === 0n) throw notFound();
    return afterFactorRemoved(tx, userId);
  });
}

// ------------------------------------------------------------------ passkeys

export interface PasskeyCredential {
  id: string;
  credentialId: Buffer;
  publicKey: Buffer;
  signCount: number;
  transports: string[];
}

/** allowCredentials and assertion verification. */
export async function listPasskeyCredentials(
  ctx: Ctx,
  userId: string,
): Promise<PasskeyCredential[]> {
  if (!isUuid(userId)) return [];
  const rows = await ctx.db
    .selectFrom("webauthn_credentials")
    .select(["id", "credential_id", "public_key", "sign_count", "transports"])
    .where("user_id", "=", userId)
    .orderBy("created_at")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    credentialId: r.credential_id,
    publicKey: r.public_key,
    signCount: r.sign_count,
    transports: r.transports,
  }));
}

/** Number of passkeys (for LIMIT_REACHED before generating registration options). */
export async function countPasskeys(ctx: Ctx, userId: string): Promise<number> {
  return (await activeFactorCount(ctx, userId)).passkeys;
}

/**
 * POST /me/mfa/passkeys (after verification). LIMIT_REACHED at 10;
 * ALREADY_EXISTS for a credential ID already registered. Recovery codes are
 * stored only if this is the first factor. Deletes open one-time tokens.
 */
export async function addPasskey(
  ctx: Ctx,
  userId: string,
  input: {
    credentialId: Buffer;
    publicKey: Buffer;
    signCount: number;
    transports: string[];
    name: string;
    recoveryCodes: RecoveryCodeHashes;
  },
): Promise<{ passkeyId: string; recoveryCodesCreated: boolean }> {
  return withTx(ctx, async (tx) => {
    await lockUser(tx, userId);
    const before = await activeFactorCount(tx, userId);
    if (before.passkeys >= LIMITS.passkeysPerUser) throw limitReached();
    const now = tx.clock();
    const id = tx.newId();
    try {
      await tx.db
        .insertInto("webauthn_credentials")
        .values({
          id,
          user_id: userId,
          credential_id: input.credentialId,
          public_key: input.publicKey,
          sign_count: input.signCount,
          transports: input.transports,
          name: input.name,
          created_at: now,
          updated_at: now,
        })
        .execute();
    } catch (e) {
      if (isUniqueViolation(e, "webauthn_credentials_credential_id_key"))
        throw new DalError("ALREADY_EXISTS");
      throw e;
    }
    const first = !before.totp && before.passkeys === 0;
    if (first) await insertRecoveryCodes(tx, userId, input.recoveryCodes);
    await deleteOpenUserTokens(tx, userId);
    return { passkeyId: id, recoveryCodesCreated: first };
  });
}

/** DELETE /me/mfa/passkeys/{id}: own passkeys only (others' -> NOT_FOUND). */
export async function removePasskey(
  ctx: Ctx,
  userId: string,
  passkeyId: string,
): Promise<{ mfaDisabled: boolean }> {
  if (!isUuid(passkeyId)) throw notFound();
  return withTx(ctx, async (tx) => {
    await lockUser(tx, userId);
    const res = await tx.db
      .deleteFrom("webauthn_credentials")
      .where("id", "=", passkeyId)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (res.numDeletedRows === 0n) throw notFound();
    return afterFactorRemoved(tx, userId);
  });
}

/** After a verified assertion: stores the new counter and last use. */
export async function recordPasskeyUse(
  ctx: Ctx,
  userId: string,
  passkeyId: string,
  signCount: number,
): Promise<void> {
  const now = ctx.clock();
  await ctx.db
    .updateTable("webauthn_credentials")
    .set({ sign_count: signCount, last_used_at: now, updated_at: now })
    .where("id", "=", passkeyId)
    .where("user_id", "=", userId)
    .execute();
}

// ------------------------------------------------------------------ WebAuthn challenges

export interface ChallengeBinding {
  purpose: WebAuthnChallengePurpose;
  /** Required for register, mfa and reauth. */
  sessionId?: string;
  /** Required for password_reset. */
  userTokenId?: string;
}

/** Stores a single-use challenge (5 minutes), replacing the outstanding one for that session or token. */
export async function createWebAuthnChallenge(
  ctx: Ctx,
  userId: string,
  binding: ChallengeBinding,
  challenge: Buffer,
): Promise<void> {
  await withTx(ctx, async (tx) => {
    const now = tx.clock();
    if (binding.sessionId !== undefined)
      await tx.db
        .deleteFrom("webauthn_challenges")
        .where("session_id", "=", binding.sessionId)
        .execute();
    if (binding.userTokenId !== undefined)
      await tx.db
        .deleteFrom("webauthn_challenges")
        .where("user_token_id", "=", binding.userTokenId)
        .execute();
    await tx.db
      .insertInto("webauthn_challenges")
      .values({
        id: tx.newId(),
        user_id: userId,
        purpose: binding.purpose,
        session_id:
          binding.purpose === "password_reset"
            ? null
            : (binding.sessionId ?? null),
        user_token_id:
          binding.purpose === "password_reset"
            ? (binding.userTokenId ?? null)
            : null,
        challenge,
        created_at: now,
        expires_at: new Date(now.getTime() + CHALLENGE_TTL_MS),
      })
      .execute();
  });
}

/** Deletes and returns the outstanding challenge if it matches the purpose and has not expired. */
export async function consumeWebAuthnChallenge(
  ctx: Ctx,
  binding: ChallengeBinding,
): Promise<{ userId: string; challenge: Buffer } | null> {
  let q = ctx.db.deleteFrom("webauthn_challenges");
  if (binding.sessionId !== undefined)
    q = q.where("session_id", "=", binding.sessionId);
  else if (binding.userTokenId !== undefined)
    q = q.where("user_token_id", "=", binding.userTokenId);
  else return null;
  const row = await q
    .returning(["user_id", "purpose", "challenge", "expires_at"])
    .executeTakeFirst();
  if (!row || row.purpose !== binding.purpose || row.expires_at <= ctx.clock())
    return null;
  return { userId: row.user_id, challenge: row.challenge };
}

// ------------------------------------------------------------------ recovery codes

/** POST /me/mfa/recovery-codes: replaces all codes. MFA_NOT_ENABLED without a factor. Deletes open tokens. */
export async function regenerateRecoveryCodes(
  ctx: Ctx,
  userId: string,
  codes: RecoveryCodeHashes,
): Promise<void> {
  await withTx(ctx, async (tx) => {
    await lockUser(tx, userId);
    const f = await activeFactorCount(tx, userId);
    if (!f.totp && f.passkeys === 0) throw new DalError("MFA_NOT_ENABLED");
    await insertRecoveryCodes(tx, userId, codes);
    await deleteOpenUserTokens(tx, userId);
  });
}

/**
 * Unused codes for the backend's constant-time comparison (F-04): it computes
 * the HMAC under each row's key and compares. Secret: never log.
 */
export async function listUnusedRecoveryCodes(
  ctx: Ctx,
  userId: string,
): Promise<{ id: string; keyId: string; codeHash: Buffer }[]> {
  if (!isUuid(userId)) return [];
  const rows = await ctx.db
    .selectFrom("recovery_codes")
    .select(["id", "key_id", "code_hash"])
    .where("user_id", "=", userId)
    .where("used_at", "is", null)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    keyId: r.key_id,
    codeHash: r.code_hash,
  }));
}

/** Marks a matched code used. False if it was used concurrently (reject). */
export async function useRecoveryCode(
  ctx: Ctx,
  userId: string,
  codeId: string,
): Promise<boolean> {
  const now = ctx.clock();
  const row = await ctx.db
    .updateTable("recovery_codes")
    .set({ used_at: now, updated_at: now })
    .where("id", "=", codeId)
    .where("user_id", "=", userId)
    .where("used_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  return row !== undefined;
}

// ------------------------------------------------------------------ keyring (rewrap-mfa, readyz)

/** readyz: every keyring key ID still referenced by a row (Internal). */
export async function listKeyIdsInUse(ctx: Ctx): Promise<string[]> {
  const rows = await sql<{ key_id: string }>`
    select key_id from totp_credentials
    union
    select key_id from recovery_codes
    order by key_id
  `.execute(ctx.db);
  return rows.rows.map((r) => r.key_id);
}

/** rewrap-mfa --dry-run: per key ID, the number of TOTP and recovery-code rows. */
export async function countMfaRowsByKeyId(
  ctx: Ctx,
): Promise<{ keyId: string; totp: number; recoveryCodes: number }[]> {
  const rows = await sql<{ key_id: string; totp: number; codes: number }>`
    select key_id, sum(t)::int as totp, sum(c)::int as codes from (
      select key_id, 1 as t, 0 as c from totp_credentials
      union all
      select key_id, 0, 1 from recovery_codes
    ) x group by key_id order by key_id
  `.execute(ctx.db);
  return rows.rows.map((r) => ({
    keyId: r.key_id,
    totp: r.totp,
    recoveryCodes: r.codes,
  }));
}

/** rewrap-mfa --yes: a batch of TOTP secrets not under `currentKeyId`. */
export async function listTotpSecretsToRewrap(
  ctx: Ctx,
  currentKeyId: string,
  limit = 100,
): Promise<{ userId: string; keyId: string; ciphertext: Buffer }[]> {
  const rows = await ctx.db
    .selectFrom("totp_credentials")
    .select(["user_id", "key_id", "secret_ciphertext"])
    .where("key_id", "<>", currentKeyId)
    .orderBy("user_id")
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    userId: r.user_id,
    keyId: r.key_id,
    ciphertext: r.secret_ciphertext,
  }));
}

/** Compare-and-swap re-encryption: only if the row is still under `fromKeyId`. */
export async function rewrapTotpSecret(
  ctx: Ctx,
  userId: string,
  input: { fromKeyId: string; toKeyId: string; ciphertext: Buffer },
): Promise<boolean> {
  if (!KEY_ID_RE.test(input.toKeyId))
    throw new TypeError("invalid keyring key ID");
  const row = await ctx.db
    .updateTable("totp_credentials")
    .set({
      key_id: input.toKeyId,
      secret_ciphertext: input.ciphertext,
      updated_at: ctx.clock(),
    })
    .where("user_id", "=", userId)
    .where("key_id", "=", input.fromKeyId)
    .returning("user_id")
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * rewrap-mfa --retire-recovery-codes <keyId> (F-38): deletes every recovery
 * code under `keyId` and records one recovery_codes_retired event per affected
 * user. dryRun only counts. Idempotent. Returns the affected user IDs (the
 * backend emails them) and the number of codes.
 */
export async function retireRecoveryCodes(
  ctx: Ctx,
  keyId: string,
  options: { dryRun?: boolean } = {},
): Promise<{ affectedUserIds: string[]; codes: number }> {
  if (!KEY_ID_RE.test(keyId)) throw new TypeError("invalid keyring key ID");
  return withTx(ctx, async (tx) => {
    const rows = await tx.db
      .selectFrom("recovery_codes")
      .select(["user_id", sql<number>`count(*)::int`.as("n")])
      .where("key_id", "=", keyId)
      .groupBy("user_id")
      .orderBy("user_id")
      .execute();
    const affectedUserIds = rows.map((r) => r.user_id);
    const codes = rows.reduce((a, r) => a + r.n, 0);
    if (options.dryRun === true || rows.length === 0)
      return { affectedUserIds, codes };
    await tx.db
      .deleteFrom("recovery_codes")
      .where("key_id", "=", keyId)
      .execute();
    const now = tx.clock();
    await tx.db
      .insertInto("security_events")
      .values(
        affectedUserIds.map((u) => ({
          id: tx.newId(),
          user_id: u,
          type: "recovery_codes_retired" as const,
          created_at: now,
        })),
      )
      .execute();
    return { affectedUserIds, codes };
  });
}

/**
 * reset-mfa admin command: deletes every factor, recovery code and open
 * one-time token (except cancel tokens, F-01), revokes every session, and
 * records admin_mfa_reset. MFA_NOT_ENABLED (exit 4) if the user has no MFA.
 * dryRun only checks eligibility.
 */
export async function resetMfa(
  ctx: Ctx,
  userId: string,
  options: { dryRun?: boolean } = {},
): Promise<{ revokedSessions: number }> {
  if (!isUuid(userId)) throw notFound();
  return withTx(ctx, async (tx) => {
    const user = await lockUser(tx, userId);
    if (!user) throw notFound();
    const f = await activeFactorCount(tx, userId);
    if (!f.totp && f.passkeys === 0) throw new DalError("MFA_NOT_ENABLED");
    if (options.dryRun === true) return { revokedSessions: 0 };
    await tx.db
      .deleteFrom("totp_credentials")
      .where("user_id", "=", userId)
      .execute();
    await tx.db
      .deleteFrom("webauthn_credentials")
      .where("user_id", "=", userId)
      .execute();
    await tx.db
      .deleteFrom("recovery_codes")
      .where("user_id", "=", userId)
      .execute();
    await deleteOpenUserTokens(tx, userId);
    const del = await tx.db
      .deleteFrom("sessions")
      .where("user_id", "=", userId)
      .executeTakeFirst();
    await tx.db
      .insertInto("security_events")
      .values({
        id: tx.newId(),
        user_id: userId,
        type: "admin_mfa_reset",
        created_at: tx.clock(),
      })
      .execute();
    return { revokedSessions: Number(del.numDeletedRows) };
  });
}
