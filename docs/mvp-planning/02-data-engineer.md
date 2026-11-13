# Meeting 2: data-engineer
Status: **meeting held 2026-11-12**

## Agent's agenda

### Proposed MVP data scope
- **Entities:**
  - User (email is PII; timezone; default currency)
  - Workspace/Budget, which owns all data
  - Account
  - CategoryGroup and Category
  - Transaction
  - BudgetAllocation (category × month)
  - RecurringRule
  - Possibly TransactionSplit
- **Invariants:**
  - Money is a signed `bigint` in minor units plus an ISO 4217 code, rounded in one place only.
  - A transaction date is a calendar `DATE`. Audit columns are `timestamptz` UTC. Budget months are first-of-month `DATE`s.
  - Every row carries `workspace_id`, and every repository function is scoped by it.
  - Soft delete via `deleted_at`. A category that transactions still use can only be archived (FK RESTRICT).
  - Transfers are two linked rows with a `transfer_id`, kept equal and opposite by a check constraint.
  - Recurring instances are unique on `(rule_id, occurrence_date)`.
  - Splits must sum to the parent, enforced by a deferred trigger.
  - IDs are UUIDv7 (clients can generate them); every table has `updated_at`.

### Decisions for the owner
1. **Database:** (a) PostgreSQL *(recommended)*, (b) SQLite, (c) hosted Postgres (Supabase or Neon)
2. **Offline:** (a) online-only, with sync-ready schema choices now *(recommended)*, (b) a read-only offline cache, (c) full offline entry with sync (about twice the data-layer work)
3. **Budgeting method:** (a) zero-based/envelope, (b) simple monthly limits *(recommended, with a schema that can extend to (a))*, (c) tracking only
4. **Currency:** (a) one per user, (b) one per account with no FX, stored now but limited to one currency in the UI *(recommended)*, (c) full multi-currency with FX
5. **Sharing:** one member in the MVP, behind a Workspace entity *(recommended)*
6. **Getting transactions in:** (a) manual, (b) manual plus CSV import *(recommended)*, (c) Plaid
7. **Retention, export and deletion:** keep history indefinitely, user-triggered CSV/JSON export, hard-delete within 30 days of account deletion, backups expire on a schedule *(recommended)*. Is GDPR or CCPA a requirement?
8. **Migration tool:** (a) plain SQL with dbmate or Flyway *(recommended)*, (b) the ORM's tool (Prisma, Drizzle or Alembic), only if it produces reviewable SQL

### Draft task list
1. db/CLAUDE.md: tool, naming conventions, reset commands
2. Database roles: `app` (DML only) and `migrator` (DDL)
3. Initial migrations with constraints and indexes, such as `(workspace_id, account_id, date)` and `(workspace_id, category_id, date)`
4. A data-access module with intent-level functions (`getMonthSummary`, `recordTransfer`, ...), tested against real Postgres
5. Deterministic seed data: a demo user with several months of transactions, plus edge cases
6. Fast reset for tests (a template database or transaction rollback)
7. Export and delete-account queries
8. `EXPLAIN` checks on the month-summary and transaction-list queries

### Dependencies
architect (language and ORM, data-model.md, auth tables) · backend (repository API shape) · ci (Postgres in compose and CI, a migrate step) · tests (reset strategy) · sre (host, PITR, encryption) · security (memo and payee fields can hold PII)

### Risks and open questions
- Budgeting method is the biggest schema risk
- Offline sync later is cheap only if the sync-ready choices are made now
- CSV import needs deduplication (a hash of date, amount and payee per account)
- Recurring transactions: generate them ahead of time (needs a job runner) or compute them when read?
- Compliance requirements are unknown

## Owner decisions (2026-11-12)
Already settled in meeting 1: PostgreSQL · monthly category limits (BudgetAllocation/MonthlyPlan) · **USD only**, integer cents · **shared budgets** (Budget + BudgetMember with owner or member role, plus Invitation) · manual entry only · online-only PWA · CSV export + 30-day deletion grace, backups expire within 35 days · $0 hosting (free-tier Postgres).

| Decision | Choice |
|---|---|
| Accounts (checking, credit, cash) | **Not in the MVP.** Transactions belong to a budget and a category. |
| Recurring transactions | **Deferred** |
| Split transactions | **Included.** Splits must sum to the parent amount, enforced in the database (owner chose this over the deferral recommendation). |
| Migration and query tooling | **Plain-SQL migrations (dbmate) + Kysely** typed query builder |

Kept as agent defaults: a transaction date is a calendar `DATE`; audit columns are `timestamptz` UTC; every row carries `budget_id`, and every repository function is scoped by it; soft delete, with categories archived rather than deleted; UUIDv7 IDs; `updated_at` on every table (sync-ready).

## Agreed tasks (approved as listed)
1. db/CLAUDE.md: dbmate and Kysely conventions, naming, reset commands
2. Database roles: `app` (read and write data only) and `migrator` (schema changes)
3. Initial migrations: users, sessions and MFA, budgets, members, invitations, categories, monthly plans, transactions, **transaction splits** (with a database check that splits sum to the parent), plus indexes for the monthly summary and the transaction list
4. Data-access module with intent-level functions (`getMonthSummary`, `createTransactionWithSplits`, `acceptInvitation`, ...), every function scoped by budget and tested against real Postgres
5. Deterministic seed data: a demo household with two members and several months of transactions, with edge cases (splits, month and year rollover, a DST change)
6. Fast database reset for tests
7. Queries for CSV export and the 30-day deletion purge
8. `EXPLAIN` checks on the summary and list queries
