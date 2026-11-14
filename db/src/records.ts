// Public record types returned by the DAL. Shapes follow api.openapi.yaml
// (camelCase), so the backend maps them with little or no work. Fields marked
// PII/Sensitive follow data-model.md "Data classification": never log them.
import type { CalendarDate, Month } from "./dates.ts";
import type {
  CategoryKind,
  DeviceBrowser,
  DeviceOs,
  Direction,
  MemberRole,
  SecurityEventType,
  SessionStatus,
  UserStatus,
} from "./schema.ts";

export interface BudgetRecord {
  id: string;
  /** Sensitive */
  name: string;
  timezone: string;
  currency: "USD";
  myRole: MemberRole;
  memberCount: number;
  /** Today in the budget timezone at the app clock's current instant. */
  today: CalendarDate;
  currentMonth: Month;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface DeletedBudgetRecord {
  id: string;
  /** Sensitive */
  name: string;
  deletedAt: Date;
  restorableUntil: Date;
  memberCount: number;
}

/** For notification emails only. PII: never log. */
export interface MemberContact {
  userId: string;
  email: string;
  displayName: string;
  role: MemberRole;
}

export interface MemberRecord {
  userId: string;
  /** PII (shown to co-members) */
  displayName: string;
  role: MemberRole;
  joinedAt: Date;
}

export type InvitationApiStatus =
  "pending" | "accepted" | "declined" | "revoked" | "expired";

export interface InvitationRecord {
  id: string;
  budgetId: string;
  /** PII */
  email: string;
  status: InvitationApiStatus;
  invitedByDisplayName: string | null;
  createdAt: Date;
  expiresAt: Date;
  respondedAt: Date | null;
}

export interface MyInvitationRecord {
  id: string;
  budgetId: string;
  /** Sensitive */
  budgetName: string;
  invitedByDisplayName: string | null;
  expiresAt: Date;
}

export interface CategoryRecord {
  id: string;
  budgetId: string;
  /** Sensitive */
  name: string;
  kind: CategoryKind;
  sortOrder: number;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface PlanEntryRecord {
  categoryId: string;
  month: Month;
  /** Sensitive */
  amountCents: number;
  updatedAt: Date;
  updatedByUserId: string | null;
  version: number;
}

export interface MonthPlanRecord {
  budgetId: string;
  month: Month;
  items: PlanEntryRecord[];
}

export interface PlanCopyResult extends MonthPlanRecord {
  sourceMonth: Month;
  copiedCount: number;
  skippedCount: number;
}

export interface SplitRecord {
  categoryId: string;
  /** Sensitive */
  amountCents: number;
}

export interface TransactionRecord {
  id: string;
  budgetId: string;
  date: CalendarDate;
  direction: Direction;
  /** Sensitive */
  amountCents: number;
  /** Sensitive */
  payee: string | null;
  /** Sensitive */
  memo: string | null;
  /** Ordered by amount descending, then categoryId. */
  splits: SplitRecord[];
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

/** Keyset position for the transaction list (the backend MACs it into a cursor). */
export interface TransactionPosition {
  date: CalendarDate;
  id: string;
}

export interface TransactionPage {
  items: TransactionRecord[];
  /** Position of the last item when another page exists, else null. */
  next: TransactionPosition | null;
}

export interface CategorySummaryRecord {
  categoryId: string;
  name: string;
  kind: CategoryKind;
  archived: boolean;
  plannedCents: number;
  actualCents: number;
  remainingCents: number;
}

export interface SummaryTotalsRecord {
  plannedCents: number;
  actualCents: number;
  remainingCents: number;
}

export interface MonthSummaryRecord {
  budgetId: string;
  month: Month;
  categories: CategorySummaryRecord[];
  totals: { expense: SummaryTotalsRecord; income: SummaryTotalsRecord };
  transactionCount: number;
}

/**
 * F-45: one second-factor attempt slot on an mfa_pending session or a
 * password-reset token, reserved atomically BEFORE the factor is checked.
 * `attempt` is the slot number (1..5). Not granted: `exhausted` = the
 * session/token is still open but all 5 slots are taken (failures plus
 * attempts in flight); `invalid` = it no longer exists, expired, or is no
 * longer pending/unused.
 */
export type MfaAttemptReservation =
  | { granted: true; attempt: number }
  | { granted: false; reason: "exhausted" | "invalid" };

export interface MfaSummaryRecord {
  enabled: boolean;
  totp: boolean;
  passkeyCount: number;
  recoveryCodesRemaining: number;
}

export interface MeRecord {
  id: string;
  /** PII */
  email: string;
  /** PII */
  displayName: string;
  status: UserStatus;
  createdAt: Date;
  mfa: MfaSummaryRecord;
  deletion: { requestedAt: Date; purgeAfter: Date } | null;
}

export interface SessionRecord {
  id: string;
  userId: string;
  status: SessionStatus;
  /** Secret: compare in constant time, never log or return to other users. */
  csrfToken: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  mfaVerifiedAt: Date | null;
  reauthAt: Date | null;
  mfaFailedAttempts: number;
  deviceBrowser: DeviceBrowser;
  deviceOs: DeviceOs;
}

export interface SessionInfoRecord {
  id: string;
  browser: DeviceBrowser;
  os: DeviceOs;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

export interface SecurityEventRecord {
  createdAt: Date;
  type: SecurityEventType;
  sessionId: string | null;
  budgetId: string | null;
  deviceBrowser: DeviceBrowser | null;
  deviceOs: DeviceOs | null;
  /** PII */
  ip: string | null;
}
