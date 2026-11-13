# ADR-0006: Shared-budget tenancy and authorization
- Status: Accepted (owner, 2026-11-12); amended by ADR-0010 (ownership transfer, self-service restore) and revised 2026-11-13 for F-13, F-18, F-25
- Date: 2026-11-12
- Areas affected: data, backend, frontend, tests, security

## Context
Households share budgets in the MVP (owner's decision, changed from the single-member recommendation). Cross-budget leaks are the most likely serious bug. Roles: one owner plus equal members. Members can view and edit transactions and limits; only the owner can invite or remove members and rename or delete the budget. Owners can add existing users; only the app owner creates sign-up invites.

## Decision
- **Tenant = Budget.** All financial data (categories, plan entries, transactions, splits, invitations) belongs to exactly one budget via `budget_id NOT NULL`. Users relate to budgets only through `budget_members (budget_id, user_id, role)`.
- **Exactly one owner per budget**, enforced in the database (partial unique index + deferred constraint trigger). The owner can transfer ownership to another member (ADR-0010) and only then leave.
- **Cross-budget references are impossible in the schema:** child tables reference parents with composite FKs `(budget_id, id)`, so a split cannot point at another budget's category or transaction.
- **Authorization pipeline:** for every `/budgets/{budgetId}/…` request, one membership query produces a `BudgetScope {budgetId, userId, role}` (a branded type only `requireMembership()` can construct). Every budget DAL function requires a `BudgetScope` and filters by `scope.budgetId`. Non-member or deleted budget → 404; insufficient role → 403.
- **Deny by default:** every route declares `x-session`, `x-budget-role` (`none` | `member` | `owner`) and `x-reauth` (`true` | `false`) explicitly; the server refuses to start if a route lacks them or if a path containing `{budgetId}` is not budget-scoped; permission tests are generated from them for anonymous, non-member, member and owner.
- **IDs in bodies and cursors (F-18):** a body `categoryId` outside the budget is 400 `VALIDATION_FAILED` (checked before writing, so the FK never fires); cursors carry a MAC over budget, filters and position; idempotent replays and the export go through `requireMembership`.
- **Role rules:** members manage transactions, splits, categories (create, rename, reorder, archive, delete unused), plan entries and copy-plan, and may leave. Owners additionally rename or change the timezone, delete (re-auth) and restore the budget, invite (re-auth, F-13), revoke invitations, remove members and transfer ownership (re-auth).
- **Budget invitations** target an email, carry no token, and are accepted only by a signed-in user whose verified email matches. Creating one gives the same response whether or not that email has an account; a notification is emailed only if it does. Pending invitations wait for future sign-ups. Limits: 6 members, 10 pending invitations, 14-day expiry.
- **Account deletion** is blocked (`OWNS_SHARED_BUDGET`) while the user still owns a budget with other members; transferring ownership first is the normal path. Deletion requests and invitation acceptance lock the budget rows, and the purge re-checks before deleting (F-25).

## Alternatives considered
- **Data owned by users, shared by grants:** many-to-many grants per resource; harder to reason about and to test.
- **Postgres row-level security (RLS) keyed by `app.user_id`:** strong defense in depth, but with connection pooling every transaction must `SET LOCAL`, Kysely support is manual, and failures are silent empty results. Rejected for the MVP in favor of `BudgetScope` + composite FKs + generated isolation tests; revisit if a leak is ever found.
- **Tokenized invitation links for budget invites:** bearer tokens can be forwarded or guessed; matching the verified email removes the token entirely.
- **"Add existing user directly" without acceptance:** lets an owner put someone into a budget without consent and confirms that the email has an account.
- **403 for non-members:** reveals that a budget ID exists.

## Consequences
- One membership query per budget request (PK lookup).
- **Conditions for accepting no RLS (R-7, F-18), enforced by tooling, not convention:** Semgrep/lint rules in `make check`/`make audit` ban type assertions to `BudgetScope` outside `requireMembership`, Kysely `db`/`sql` imports outside `db/`, and budget DAL functions taking a raw `budgetId`; the two-household suite runs every DAL function with a scope for budget A against a database seeded with budget B.
- data-engineer: composite FKs, owner trigger, scoped DAL signatures, row locks for deletion/acceptance/transfer. backend: `requireMembership`, route-table startup check, body-ID validation, cursor MAC. ci: the Semgrep rules. tests: generated permission matrix and the isolation suite. frontend: hide owner-only actions for members, while the server still enforces them.
- Roles beyond owner/member and per-category permissions need new ADRs. Co-members remain fully trusted with each other's budget data (accepted risk R-4, OD-7).
