// Internal helpers shared by the repositories. Not exported from the package.
import { sql } from "kysely";
import type { Ctx } from "../context.ts";
import { budgetCalendar } from "../dates.ts";
import { DalError, notFound } from "../errors.ts";
import type { BudgetRecord, MemberContact } from "../records.ts";
import type { IdempotencyResourceType } from "../schema.ts";

export const LIMITS = {
  /** Non-deleted budgets a user may create or join (soft limit). */
  budgetsPerUser: 10,
  /** Hard bound that only a restore may reach (F-37). */
  budgetsPerUserHard: 20,
  membersPerBudget: 6,
  pendingInvitationsPerBudget: 10,
  pendingInvitationsPerEmail: 20,
  categoriesPerBudget: 100,
  splitsPerTransaction: 20,
  passkeysPerUser: 10,
  activeSessionsPerUser: 20,
  pendingSessionsPerUser: 5,
  /** Second-factor attempts per mfa_pending session and per reset token (F-45). */
  mfaAttemptsPerSessionOrToken: 5,
  maxAmountCents: 100_000_000,
  deletedBudgetsListed: 20,
} as const;

/** Locks a user row (FOR UPDATE): serializes membership changes per user. */
export async function lockUser(
  ctx: Ctx,
  userId: string,
): Promise<{ status: string; email: string } | undefined> {
  return ctx.db
    .selectFrom("users")
    .select(["status", "email"])
    .where("id", "=", userId)
    .forUpdate()
    .executeTakeFirst();
}

/** Non-deleted budgets the user is a member of. */
export async function countLiveBudgets(
  ctx: Ctx,
  userId: string,
): Promise<number> {
  const row = await ctx.db
    .selectFrom("budget_members as m")
    .innerJoin("budgets as b", "b.id", "m.budget_id")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("m.user_id", "=", userId)
    .where("b.deleted_at", "is", null)
    .executeTakeFirstOrThrow();
  return row.n;
}

export async function loadBudgetRecord(
  ctx: Ctx,
  budgetId: string,
  userId: string,
): Promise<BudgetRecord> {
  const row = await ctx.db
    .selectFrom("budgets as b")
    .innerJoin("budget_members as m", (j) =>
      j.onRef("m.budget_id", "=", "b.id").on("m.user_id", "=", userId),
    )
    .select([
      "b.id",
      "b.name",
      "b.timezone",
      "b.created_at",
      "b.updated_at",
      "b.version",
      "m.role",
      sql<number>`(select count(*)::int from budget_members c where c.budget_id = b.id)`.as(
        "member_count",
      ),
    ])
    .where("b.id", "=", budgetId)
    .where("b.deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) throw notFound();
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    currency: "USD",
    myRole: row.role,
    memberCount: row.member_count,
    ...budgetCalendar(ctx.clock(), row.timezone),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export async function loadMemberContacts(
  ctx: Ctx,
  budgetId: string,
): Promise<MemberContact[]> {
  const rows = await ctx.db
    .selectFrom("budget_members as m")
    .innerJoin("users as u", "u.id", "m.user_id")
    .select(["m.user_id", "u.email", "u.display_name", "m.role"])
    .where("m.budget_id", "=", budgetId)
    .orderBy("m.role", "asc")
    .orderBy("m.joined_at", "asc")
    .execute();
  return rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
  }));
}

export interface IdempotencyInput {
  userId: string;
  /** Client Idempotency-Key (uuid). */
  key: string;
  /** SHA-256 of method + route template + path params + canonical body (32 bytes). */
  requestHash: Buffer;
}

/**
 * Claims an idempotency key inside the creating transaction (data-model.md
 * idempotency_keys). Concurrent duplicates serialize on the primary key: the
 * loser waits for the winner's commit, then sees its row.
 * Returns null when claimed (proceed and create `resourceId`), or the id of
 * the previously created resource (replay). Same key with another request
 * -> IDEMPOTENCY_KEY_REUSED. Keys older than 24 h are treated as unused.
 */
export async function claimIdempotencyKey(
  ctx: Ctx,
  input: IdempotencyInput,
  resourceType: IdempotencyResourceType,
  resourceId: string,
): Promise<string | null> {
  const now = ctx.clock();
  const cutoff = new Date(now.getTime() - 24 * 3_600_000);
  await ctx.db
    .deleteFrom("idempotency_keys")
    .where("user_id", "=", input.userId)
    .where("key", "=", input.key)
    .where("created_at", "<", cutoff)
    .execute();
  const inserted = await ctx.db
    .insertInto("idempotency_keys")
    .values({
      user_id: input.userId,
      key: input.key,
      request_hash: input.requestHash,
      resource_type: resourceType,
      resource_id: resourceId,
      created_at: now,
    })
    .onConflict((oc) => oc.columns(["user_id", "key"]).doNothing())
    .returning("resource_id")
    .executeTakeFirst();
  if (inserted) return null;
  const existing = await ctx.db
    .selectFrom("idempotency_keys")
    .select(["request_hash", "resource_type", "resource_id"])
    .where("user_id", "=", input.userId)
    .where("key", "=", input.key)
    .executeTakeFirstOrThrow();
  if (
    existing.resource_type !== resourceType ||
    !existing.request_hash.equals(input.requestHash)
  ) {
    throw new DalError("IDEMPOTENCY_KEY_REUSED", {
      details: [
        { in: "header", field: "Idempotency-Key", issue: "invalid_value" },
      ],
    });
  }
  return existing.resource_id;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * F-01: revocation events delete every open one-time token of the user except
 * email_change_cancel tokens (and webauthn challenges bound to them cascade).
 * `alsoCancel` is only for `revoke-sessions --all --restore` (F-11).
 */
export async function deleteOpenUserTokens(
  ctx: Ctx,
  userId: string,
  options: { alsoCancel?: boolean; exceptTokenId?: string } = {},
): Promise<number> {
  let q = ctx.db
    .deleteFrom("user_tokens")
    .where("user_id", "=", userId)
    .where("used_at", "is", null);
  if (options.alsoCancel !== true)
    q = q.where("purpose", "<>", "email_change_cancel");
  if (options.exceptTokenId !== undefined)
    q = q.where("id", "<>", options.exceptTokenId);
  const res = await q.executeTakeFirst();
  return Number(res.numDeletedRows);
}

/**
 * The one rule shared by the deletion request and the purge re-check (F-35):
 * does the user own a NON-deleted budget that has another member?
 * Locks every budget the user owns (FOR UPDATE, F-25).
 */
export async function lockOwnedBudgetsAndCheckShared(
  ctx: Ctx,
  userId: string,
): Promise<{ ownsSharedBudget: boolean; ownedBudgetIds: string[] }> {
  const owned = await ctx.db
    .selectFrom("budgets as b")
    .innerJoin("budget_members as m", (j) =>
      j
        .onRef("m.budget_id", "=", "b.id")
        .on("m.user_id", "=", userId)
        .on("m.role", "=", "owner"),
    )
    .select(["b.id", "b.deleted_at"])
    .orderBy("b.id")
    .forUpdate("b")
    .execute();
  let shared = false;
  for (const b of owned) {
    if (b.deleted_at !== null) continue;
    const other = await ctx.db
      .selectFrom("budget_members")
      .select("user_id")
      .where("budget_id", "=", b.id)
      .where("user_id", "<>", userId)
      .limit(1)
      .executeTakeFirst();
    if (other) shared = true;
  }
  return { ownsSharedBudget: shared, ownedBudgetIds: owned.map((b) => b.id) };
}

/**
 * Non-locking re-check of the same rule, for use after `lockUser(userId)`.
 * Ownership can only move TO a user through transferOwnership, which locks
 * that user's row before committing; so once the caller holds the user lock, a
 * fresh read here sees every transfer that could have slipped in after
 * lockOwnedBudgetsAndCheckShared, and none can commit until the caller does.
 * (Locking those budgets here would invert the budget-before-user lock order.)
 */
export async function ownsSharedLiveBudget(
  ctx: Ctx,
  userId: string,
): Promise<boolean> {
  const row = await ctx.db
    .selectFrom("budget_members as m")
    .innerJoin("budgets as b", "b.id", "m.budget_id")
    .select("m.budget_id")
    .where("m.user_id", "=", userId)
    .where("m.role", "=", "owner")
    .where("b.deleted_at", "is", null)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("budget_members as o")
          .select("o.user_id")
          .whereRef("o.budget_id", "=", "m.budget_id")
          .where("o.user_id", "<>", userId),
      ),
    )
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}
