// DAL records -> API JSON. Each mapper lists the contract's fields explicitly,
// so responses never carry fields the contract does not define, and every
// instant is RFC 3339 UTC with milliseconds.
import type {
  BudgetRecord,
  CategoryRecord,
  InvitationRecord,
  MeRecord,
  MemberRecord,
  MonthPlanRecord,
  MonthSummaryRecord,
  MyInvitationRecord,
  PlanCopyResult,
  PlanEntryRecord,
  TransactionRecord,
} from "@shoestring/db";

export const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null =>
  d ? d.toISOString() : null;

export function toMe(m: MeRecord) {
  return {
    id: m.id,
    email: m.email,
    displayName: m.displayName,
    createdAt: iso(m.createdAt),
    mfa: {
      enabled: m.mfa.enabled,
      totp: m.mfa.totp,
      passkeyCount: m.mfa.passkeyCount,
      recoveryCodesRemaining: m.mfa.recoveryCodesRemaining,
    },
    deletion: m.deletion
      ? {
          requestedAt: iso(m.deletion.requestedAt),
          purgeAfter: iso(m.deletion.purgeAfter),
        }
      : null,
  };
}

export function toBudget(b: BudgetRecord) {
  return {
    id: b.id,
    name: b.name,
    timezone: b.timezone,
    currency: b.currency,
    myRole: b.myRole,
    memberCount: b.memberCount,
    today: b.today,
    currentMonth: b.currentMonth,
    createdAt: iso(b.createdAt),
    updatedAt: iso(b.updatedAt),
    version: b.version,
  };
}

export function toMember(m: MemberRecord) {
  return {
    userId: m.userId,
    displayName: m.displayName,
    role: m.role,
    joinedAt: iso(m.joinedAt),
  };
}

export function toInvitation(i: InvitationRecord) {
  return {
    id: i.id,
    budgetId: i.budgetId,
    email: i.email,
    status: i.status,
    invitedByDisplayName: i.invitedByDisplayName,
    createdAt: iso(i.createdAt),
    expiresAt: iso(i.expiresAt),
    respondedAt: isoOrNull(i.respondedAt),
  };
}

export function toMyInvitation(i: MyInvitationRecord) {
  return {
    id: i.id,
    budgetId: i.budgetId,
    budgetName: i.budgetName,
    invitedByDisplayName: i.invitedByDisplayName,
    expiresAt: iso(i.expiresAt),
  };
}

export function toCategory(c: CategoryRecord) {
  return {
    id: c.id,
    budgetId: c.budgetId,
    name: c.name,
    kind: c.kind,
    sortOrder: c.sortOrder,
    archived: c.archived,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
    version: c.version,
  };
}

export function toPlanEntry(p: PlanEntryRecord) {
  return {
    categoryId: p.categoryId,
    month: p.month,
    amountCents: p.amountCents,
    updatedAt: iso(p.updatedAt),
    updatedByUserId: p.updatedByUserId,
    version: p.version,
  };
}

export function toMonthPlan(p: MonthPlanRecord) {
  return {
    budgetId: p.budgetId,
    month: p.month,
    items: p.items.map(toPlanEntry),
  };
}

export function toPlanCopyResult(p: PlanCopyResult) {
  return {
    budgetId: p.budgetId,
    month: p.month,
    sourceMonth: p.sourceMonth,
    copiedCount: p.copiedCount,
    skippedCount: p.skippedCount,
    items: p.items.map(toPlanEntry),
  };
}

export function toMonthSummary(s: MonthSummaryRecord) {
  const totals = (t: MonthSummaryRecord["totals"]["expense"]) => ({
    plannedCents: t.plannedCents,
    actualCents: t.actualCents,
    remainingCents: t.remainingCents,
  });
  return {
    budgetId: s.budgetId,
    month: s.month,
    categories: s.categories.map((c) => ({
      categoryId: c.categoryId,
      name: c.name,
      kind: c.kind,
      archived: c.archived,
      plannedCents: c.plannedCents,
      actualCents: c.actualCents,
      remainingCents: c.remainingCents,
    })),
    totals: {
      expense: totals(s.totals.expense),
      income: totals(s.totals.income),
    },
    transactionCount: s.transactionCount,
  };
}

export function toTransaction(t: TransactionRecord) {
  return {
    id: t.id,
    budgetId: t.budgetId,
    date: t.date,
    direction: t.direction,
    amountCents: t.amountCents,
    payee: t.payee,
    memo: t.memo,
    splits: t.splits.map((s) => ({
      categoryId: s.categoryId,
      amountCents: s.amountCents,
    })),
    createdByUserId: t.createdByUserId,
    updatedByUserId: t.updatedByUserId,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
    version: t.version,
  };
}
