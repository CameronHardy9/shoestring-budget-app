// Daily purge (data-model.md "Deletion and purge", admin-commands.md `purge`).
// Idempotent; returns counts only. Each user is purged in its own transaction.
import { sql } from "kysely";
import type { Ctx } from "../context.ts";
import { DAY_MS, HOUR_MS, MINUTE_MS, withTx } from "../context.ts";
import { lockOwnedBudgetsAndCheckShared } from "./common.ts";

export interface PurgeCounts {
  usersPurged: number;
  /** Users skipped by the F-25/F-35 re-check. Non-zero means the run must fail (alert). */
  usersSkipped: number;
  /** Budgets hard-deleted with their owner in step 1. */
  ownedBudgetsPurged: number;
  budgetsPurged: number;
  transactionsPurged: number;
  sessions: number;
  webauthnChallenges: number;
  userTokens: number;
  signupInvites: number;
  totpSetups: number;
  idempotencyKeys: number;
  authThrottles: number;
  securityEvents: number;
  invitations: number;
}

export interface PurgeResult extends PurgeCounts {
  /** true when usersSkipped > 0: the purge command exits 1 so the alert fires. */
  failed: boolean;
}

async function count(q: {
  executeTakeFirst(): Promise<{ numDeletedRows: bigint }>;
}): Promise<number> {
  return Number((await q.executeTakeFirst()).numDeletedRows);
}

export async function runPurge(
  ctx: Ctx,
  options: { dryRun?: boolean } = {},
): Promise<PurgeResult> {
  const dry = options.dryRun === true;
  const now = ctx.clock();
  const days = (n: number): Date => new Date(now.getTime() - n * DAY_MS);
  const c: PurgeCounts = {
    usersPurged: 0,
    usersSkipped: 0,
    ownedBudgetsPurged: 0,
    budgetsPurged: 0,
    transactionsPurged: 0,
    sessions: 0,
    webauthnChallenges: 0,
    userTokens: 0,
    signupInvites: 0,
    totpSetups: 0,
    idempotencyKeys: 0,
    authThrottles: 0,
    securityEvents: 0,
    invitations: 0,
  };

  // 1. Users whose 30-day grace has ended.
  const due = await ctx.db
    .selectFrom("users")
    .select("id")
    .where("status", "=", "pending_deletion")
    .where("purge_after", "<=", now)
    .orderBy("id")
    .execute();
  for (const { id } of due) {
    await withTx(ctx, async (tx) => {
      const still = await tx.db
        .selectFrom("users")
        .select("id")
        .where("id", "=", id)
        .where("status", "=", "pending_deletion")
        .where("purge_after", "<=", now)
        .forUpdate()
        .executeTakeFirst();
      if (!still) return;
      const { ownsSharedBudget, ownedBudgetIds } =
        await lockOwnedBudgetsAndCheckShared(tx, id);
      if (ownsSharedBudget) {
        c.usersSkipped++;
        return;
      }
      c.ownedBudgetsPurged += ownedBudgetIds.length;
      c.usersPurged++;
      if (dry) return;
      // Owned budgets first, including soft-deleted ones still in their
      // restore window (F-35), then the user (the one-owner trigger needs it).
      if (ownedBudgetIds.length > 0)
        await tx.db
          .deleteFrom("budgets")
          .where("id", "in", ownedBudgetIds)
          .execute();
      await tx.db.deleteFrom("users").where("id", "=", id).execute();
    });
  }

  // Steps 2-4, in one transaction. A dry run executes the same statements and
  // rolls back, so the counts use exactly the same predicates.
  const steps = async (db: Ctx["db"]): Promise<void> => {
    c.budgetsPurged = await count(
      db.deleteFrom("budgets").where("deleted_at", "<=", days(30)),
    );
    c.transactionsPurged = await count(
      db.deleteFrom("transactions").where("deleted_at", "<=", days(30)),
    );
    c.sessions = await count(
      db.deleteFrom("sessions").where("expires_at", "<=", days(7)),
    );
    c.webauthnChallenges = await count(
      db.deleteFrom("webauthn_challenges").where("expires_at", "<=", days(7)),
    );
    c.userTokens = await count(
      db.deleteFrom("user_tokens").where("expires_at", "<=", days(7)),
    );
    c.signupInvites = await count(
      db.deleteFrom("signup_invites").where("expires_at", "<=", days(7)),
    );
    c.totpSetups = await count(
      db
        .deleteFrom("totp_credentials")
        .where("confirmed_at", "is", null)
        .where("created_at", "<=", new Date(now.getTime() - 15 * MINUTE_MS)),
    );
    c.idempotencyKeys = await count(
      db
        .deleteFrom("idempotency_keys")
        .where("created_at", "<=", new Date(now.getTime() - 24 * HOUR_MS)),
    );
    c.authThrottles = await count(
      db
        .deleteFrom("auth_throttles")
        .where("window_start", "<=", new Date(now.getTime() - 24 * HOUR_MS)),
    );
    c.invitations = await count(
      db
        .deleteFrom("budget_invitations")
        .where((eb) =>
          eb.or([
            eb.and([
              eb("status", "<>", "pending"),
              eb("responded_at", "<=", days(30)),
            ]),
            eb.and([
              eb("status", "=", "pending"),
              eb("expires_at", "<=", days(30)),
            ]),
          ]),
        ),
    );
  };
  if (dry) {
    await ctx.db
      .transaction()
      .execute(async (trx) => {
        await steps(trx);
        throw new DryRunRollback();
      })
      .catch((e: unknown) => {
        if (!(e instanceof DryRunRollback)) throw e;
      });
  } else {
    await withTx(ctx, (tx) => steps(tx.db));
  }

  // security_events: app cannot DELETE; the SECURITY DEFINER function uses the
  // database clock (F-26), so the dry run counts with the same clock.
  if (dry) {
    const r = await sql<{
      n: number;
    }>`select count(*)::int as n from security_events where created_at < now() - interval '90 days'`.execute(
      ctx.db,
    );
    c.securityEvents = r.rows[0]?.n ?? 0;
  } else {
    const r = await sql<{
      n: number;
    }>`select purge_security_events()::int as n`.execute(ctx.db);
    c.securityEvents = r.rows[0]?.n ?? 0;
  }

  return { ...c, failed: c.usersSkipped > 0 };
}

class DryRunRollback extends Error {}
