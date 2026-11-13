// Kysely table types, mirroring migrations/*.sql exactly. Internal to db/:
// the backend never sees these (it uses the record types in records.ts).
//
// Type mapping (see client.ts for the parsers):
//   uuid, text, citext, enums, inet -> string
//   bigint (int8)                   -> number (safe-integer checked)
//   date                            -> string 'YYYY-MM-DD' (never a JS Date)
//   timestamptz                     -> Date
//   bytea                           -> Buffer
import type { ColumnType, Generated } from "kysely";

type Timestamp = Date;
type DateString = string;
/** Column with a database default that the DAL may still set. */
type Defaulted<T> = ColumnType<T, T | undefined, T>;

export type UserStatus = "active" | "pending_deletion";
export type SessionStatus = "mfa_pending" | "active";
export type DeviceBrowser =
  | "safari"
  | "chrome"
  | "firefox"
  | "edge"
  | "samsung_internet"
  | "other"
  | "unknown";
export type DeviceOs =
  | "ios"
  | "ipados"
  | "android"
  | "macos"
  | "windows"
  | "linux"
  | "chromeos"
  | "other"
  | "unknown";
export type UserTokenPurpose =
  "password_reset" | "email_change" | "email_change_cancel";
export type WebAuthnChallengePurpose =
  "register" | "mfa" | "reauth" | "password_reset";
export type IdempotencyResourceType = "budget" | "transaction";
export type MemberRole = "owner" | "member";
export type InvitationStatus = "pending" | "accepted" | "declined" | "revoked";
export type CategoryKind = "expense" | "income";
export type Direction = "outflow" | "inflow";

export const SECURITY_EVENT_TYPES = [
  "signup",
  "login_succeeded",
  "login_failed",
  "mfa_succeeded",
  "mfa_failed",
  "mfa_locked",
  "recovery_code_used",
  "reauth_succeeded",
  "reauth_failed",
  "logout",
  "session_revoked",
  "sessions_revoked_others",
  "password_changed",
  "password_reset_requested",
  "password_reset_completed",
  "email_change_requested",
  "email_changed",
  "email_change_cancelled",
  "mfa_enabled",
  "mfa_factor_added",
  "mfa_factor_removed",
  "mfa_disabled",
  "recovery_codes_regenerated",
  "recovery_codes_retired",
  "passkey_counter_regression",
  "data_exported",
  "account_deletion_requested",
  "account_deletion_cancelled",
  "budget_invitation_created",
  "budget_invitation_accepted",
  "budget_invitation_revoked",
  "budget_member_removed",
  "budget_ownership_transferred",
  "budget_deleted",
  "budget_restored",
  "admin_signup_invite_created",
  "admin_mfa_reset",
  "admin_sessions_revoked",
] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

export interface UsersTable {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  email_verified_at: Timestamp;
  status: Defaulted<UserStatus>;
  deletion_requested_at: Timestamp | null;
  purge_after: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  token_hash: Buffer;
  csrf_token: string;
  status: SessionStatus;
  created_at: Timestamp;
  updated_at: Timestamp;
  last_seen_at: Timestamp;
  expires_at: Timestamp;
  absolute_expires_at: Timestamp;
  mfa_verified_at: Timestamp | null;
  reauth_at: Timestamp | null;
  mfa_failed_attempts: Defaulted<number>;
  device_browser: DeviceBrowser;
  device_os: DeviceOs;
}

export interface SignupInvitesTable {
  id: string;
  email: string;
  token_hash: Buffer;
  created_at: Timestamp;
  updated_at: Timestamp;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  revoked_at: Timestamp | null;
  used_by_user_id: string | null;
}

export interface UserTokensTable {
  id: string;
  user_id: string;
  purpose: UserTokenPurpose;
  token_hash: Buffer;
  email: string | null;
  requested_by_session_id: string | null;
  mfa_failed_attempts: Defaulted<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
  expires_at: Timestamp;
  used_at: Timestamp | null;
}

export interface TotpCredentialsTable {
  user_id: string;
  key_id: string;
  secret_ciphertext: Buffer;
  confirmed_at: Timestamp | null;
  last_used_step: number | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface WebAuthnCredentialsTable {
  id: string;
  user_id: string;
  credential_id: Buffer;
  public_key: Buffer;
  sign_count: number;
  transports: Defaulted<string[]>;
  name: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  last_used_at: Timestamp | null;
}

export interface WebAuthnChallengesTable {
  id: string;
  user_id: string;
  purpose: WebAuthnChallengePurpose;
  session_id: string | null;
  user_token_id: string | null;
  challenge: Buffer;
  created_at: Timestamp;
  expires_at: Timestamp;
}

export interface RecoveryCodesTable {
  id: string;
  user_id: string;
  key_id: string;
  code_hash: Buffer;
  used_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SecurityEventsTable {
  id: string;
  user_id: string | null;
  session_id: string | null;
  budget_id: string | null;
  type: SecurityEventType;
  device_browser: DeviceBrowser | null;
  device_os: DeviceOs | null;
  ip: string | null;
  created_at: Timestamp;
}

export interface AuthThrottlesTable {
  scope: string;
  key_hash: Buffer;
  window_start: Timestamp;
  count: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface IdempotencyKeysTable {
  user_id: string;
  key: string;
  request_hash: Buffer;
  resource_type: IdempotencyResourceType;
  resource_id: string;
  created_at: Timestamp;
}

export interface BudgetsTable {
  id: string;
  name: string;
  timezone: string;
  currency: Defaulted<string>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: Generated<number>;
  deleted_at: Timestamp | null;
}

export interface BudgetMembersTable {
  budget_id: string;
  user_id: string;
  role: MemberRole;
  joined_at: Timestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BudgetInvitationsTable {
  id: string;
  budget_id: string;
  email: string;
  invited_by_user_id: string | null;
  status: Defaulted<InvitationStatus>;
  created_at: Timestamp;
  updated_at: Timestamp;
  expires_at: Timestamp;
  responded_at: Timestamp | null;
  accepted_user_id: string | null;
}

export interface CategoriesTable {
  id: string;
  budget_id: string;
  name: string;
  kind: CategoryKind;
  sort_order: number;
  archived_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: Generated<number>;
}

export interface PlanEntriesTable {
  id: string;
  budget_id: string;
  category_id: string;
  month: DateString;
  amount_cents: number;
  updated_by_user_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: Generated<number>;
}

export interface TransactionsTable {
  id: string;
  budget_id: string;
  date: DateString;
  direction: Direction;
  amount_cents: number;
  payee: string | null;
  memo: string | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: Generated<number>;
  deleted_at: Timestamp | null;
}

export interface TransactionSplitsTable {
  id: string;
  budget_id: string;
  transaction_id: string;
  category_id: string;
  amount_cents: number;
  created_at: Timestamp;
}

export interface SchemaMigrationsTable {
  version: string;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  signup_invites: SignupInvitesTable;
  user_tokens: UserTokensTable;
  totp_credentials: TotpCredentialsTable;
  webauthn_credentials: WebAuthnCredentialsTable;
  webauthn_challenges: WebAuthnChallengesTable;
  recovery_codes: RecoveryCodesTable;
  security_events: SecurityEventsTable;
  auth_throttles: AuthThrottlesTable;
  idempotency_keys: IdempotencyKeysTable;
  budgets: BudgetsTable;
  budget_members: BudgetMembersTable;
  budget_invitations: BudgetInvitationsTable;
  categories: CategoriesTable;
  plan_entries: PlanEntriesTable;
  transactions: TransactionsTable;
  transaction_splits: TransactionSplitsTable;
  schema_migrations: SchemaMigrationsTable;
}
