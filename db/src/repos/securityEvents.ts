// Audit log (auth.md §15, F-26). The app role may only INSERT and SELECT.
// Never put emails, passwords, codes or financial data in an event.
import type { Ctx } from "../context.ts";
import type { SecurityEventRecord } from "../records.ts";
import type { DeviceBrowser, DeviceOs, SecurityEventType } from "../schema.ts";
import { isUuid } from "../scope.ts";

export interface SecurityEventInput {
  type: SecurityEventType;
  /** null for login_failed on an unknown email */
  userId: string | null;
  sessionId?: string | null;
  /** Set for budget events (F-26). */
  budgetId?: string | null;
  deviceBrowser?: DeviceBrowser | null;
  deviceOs?: DeviceOs | null;
  /** PII, kept 90 days (R-6). */
  ip?: string | null;
}

export async function recordSecurityEvent(
  ctx: Ctx,
  input: SecurityEventInput,
): Promise<void> {
  await ctx.db
    .insertInto("security_events")
    .values({
      id: ctx.newId(),
      user_id: input.userId,
      session_id: input.sessionId ?? null,
      budget_id: input.budgetId ?? null,
      type: input.type,
      device_browser: input.deviceBrowser ?? null,
      device_os: input.deviceOs ?? null,
      ip: input.ip ?? null,
      created_at: ctx.clock(),
    })
    .execute();
}

/** security-events admin command (read-only): newest first, at most 500. */
export async function listSecurityEventsForUser(
  ctx: Ctx,
  userId: string,
  options: { since?: Date; limit?: number } = {},
): Promise<SecurityEventRecord[]> {
  if (!isUuid(userId)) return [];
  let q = ctx.db
    .selectFrom("security_events")
    .select([
      "created_at",
      "type",
      "session_id",
      "budget_id",
      "device_browser",
      "device_os",
      "ip",
    ])
    .where("user_id", "=", userId);
  if (options.since) q = q.where("created_at", ">=", options.since);
  const rows = await q
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(Math.min(Math.max(options.limit ?? 500, 1), 500))
    .execute();
  return rows.map((r) => ({
    createdAt: r.created_at,
    type: r.type,
    sessionId: r.session_id,
    budgetId: r.budget_id,
    deviceBrowser: r.device_browser,
    deviceOs: r.device_os,
    ip: r.ip,
  }));
}
