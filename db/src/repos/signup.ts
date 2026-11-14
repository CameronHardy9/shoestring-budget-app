// Invite-only sign-up (auth.md §4). Token hashes only; the plaintext token is
// generated, emailed and forgotten by the backend.
import type { Ctx } from "../context.ts";
import { DAY_MS, withTx } from "../context.ts";
import { DalError, isUniqueViolation } from "../errors.ts";
import { normalizeEmail } from "./common.ts";

const invalidInvite = (): DalError => new DalError("INVITATION_INVALID");

/**
 * create-signup-invite admin command: revokes any earlier open invite for the
 * email in the same transaction. ALREADY_EXISTS when an account already uses
 * the email (the command exits 4).
 */
export async function createSignupInvite(
  ctx: Ctx,
  rawEmail: string,
  tokenHash: Buffer,
): Promise<{ inviteId: string; expiresAt: Date }> {
  const email = normalizeEmail(rawEmail);
  return withTx(ctx, async (tx) => {
    const existing = await tx.db
      .selectFrom("users")
      .select("id")
      .where("email", "=", email)
      .executeTakeFirst();
    if (existing) throw new DalError("ALREADY_EXISTS");
    const now = tx.clock();
    await tx.db
      .updateTable("signup_invites")
      .set({ revoked_at: now, updated_at: now })
      .where("email", "=", email)
      .where("used_at", "is", null)
      .where("revoked_at", "is", null)
      .execute();
    const id = tx.newId();
    const expiresAt = new Date(now.getTime() + 7 * DAY_MS);
    await tx.db
      .insertInto("signup_invites")
      .values({
        id,
        email,
        token_hash: tokenHash,
        created_at: now,
        updated_at: now,
        expires_at: expiresAt,
      })
      .execute();
    return { inviteId: id, expiresAt };
  });
}

/**
 * POST /auth/signup/preview: the invite's email and expiry (exactly the
 * contract's SignupPreview fields), or INVITATION_INVALID.
 */
export async function previewSignupInvite(
  ctx: Ctx,
  tokenHash: Buffer,
): Promise<{ email: string; expiresAt: Date }> {
  const row = await ctx.db
    .selectFrom("signup_invites")
    .select(["email", "expires_at"])
    .where("token_hash", "=", tokenHash)
    .where("used_at", "is", null)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", ctx.clock())
    .executeTakeFirst();
  if (!row) throw invalidInvite();
  return { email: row.email, expiresAt: row.expires_at };
}

/**
 * POST /auth/signup: consumes the invite and creates the user in one
 * transaction. The email comes from the invite, never from input, and counts as
 * verified.
 */
export async function signUpWithInvite(
  ctx: Ctx,
  input: { tokenHash: Buffer; displayName: string; passwordHash: string },
): Promise<{ userId: string; email: string }> {
  return withTx(ctx, async (tx) => {
    const now = tx.clock();
    const invite = await tx.db
      .selectFrom("signup_invites")
      .select(["id", "email", "used_at", "revoked_at", "expires_at"])
      .where("token_hash", "=", input.tokenHash)
      .forUpdate()
      .executeTakeFirst();
    if (
      !invite ||
      invite.used_at !== null ||
      invite.revoked_at !== null ||
      invite.expires_at <= now
    )
      throw invalidInvite();
    const userId = tx.newId();
    try {
      await tx.db
        .insertInto("users")
        .values({
          id: userId,
          email: invite.email,
          display_name: input.displayName,
          password_hash: input.passwordHash,
          email_verified_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute();
    } catch (e) {
      if (isUniqueViolation(e, "users_email_key")) throw invalidInvite();
      throw e;
    }
    await tx.db
      .updateTable("signup_invites")
      .set({ used_at: now, used_by_user_id: userId, updated_at: now })
      .where("id", "=", invite.id)
      .execute();
    return { userId, email: invite.email };
  });
}
