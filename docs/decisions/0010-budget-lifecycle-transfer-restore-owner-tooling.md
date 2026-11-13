# ADR-0010: Budget lifecycle: ownership transfer, self-service restore and owner tooling
- Status: Decisions 1–2 **Accepted (owner, 2026-11-12)** (ownership transfer; OD-5). Decisions 3–4 **Accepted (owner, 2026-11-13)**. Revised 2026-11-13 for F-35, F-36, the round-2 limit ruling and the restore-mode/`rewrap-mfa` tooling.
- Date: 2026-11-13
- Areas affected: data, backend, frontend, tests, sre, security
- Amends: ADR-0006. Inputs: owner rulings in mvp-planning/10 (ownership transfer, OD-5), security findings F-11, F-12, F-14, F-25, F-26

## Context
ADR-0006 had no ownership transfer, so an owner of a shared budget could neither leave nor delete their account (`OWNS_SHARED_BUDGET` was a dead end). A deleted budget was soft-deleted for 30 days, but nothing could restore it short of ad-hoc production SQL (F-14). With MFA optional (R-1), a phished owner could delete a household's data. Incident response also needed a way to read the audit log, and a restore from backup needed a way to revoke everything at once, again without raw SQL (F-11, F-26).

## Decision
1. **Ownership transfer.** `POST /budgets/{budgetId}/transfer-ownership {userId}`:
   - **Who:** owner only, with re-auth. The target must be a current member with an active account.
   - **How:** one transaction holding a row lock on the budget. Demote the owner to member, then promote the target; the deferred trigger checks for exactly one owner at commit.
   - **After:** it takes effect immediately; all members are emailed and `budget_ownership_transferred` is recorded. The former owner can then leave or delete their account. There is **no acceptance step** (owner ruling, round 2): ownership only adds powers, and every member is notified.
   - `OWNS_SHARED_BUDGET` remains for an owner who has not transferred yet. `OWNER_CANNOT_LEAVE` now tells the owner to transfer first.
2. **Self-service restore (OD-5, replaces F-14's `restore-budget` admin command).**
   - `GET /me/deleted-budgets` lists budgets the caller owns that were deleted in the last 30 days.
   - `POST /me/deleted-budgets/{deletedBudgetId}/restore` clears `deleted_at`. It needs no re-auth: it only undoes harm.
   - Soft delete leaves memberships and content untouched, so everything returns as it was.
   - All members are emailed on deletion and on restore; `budget_deleted` and `budget_restored` are recorded.
   - These routes are deliberately **not** `/budgets/{budgetId}` routes, because deleted budgets must stay invisible to the membership check.
   - **Scope (F-36):** a second branded constructor in `db/`, `requireDeletedBudgetOwnership(userId, budgetId)`, confirms with a row lock an owner membership on a budget soft-deleted no more than 30 days ago, whose owner account is not pending deletion. It returns a `DeletedBudgetScope`, which is the only thing the restore DAL function accepts.
     - The route declares `x-budget-role: deleted_budget_owner`, and the startup check and the generated permission tests treat `{deletedBudgetId}` like `{budgetId}`.
     - The list is a user-scoped query (owner memberships of the caller only).
     - Anything else is 404.
   - **Limit (owner ruling, round 2):** soft-deleted budgets do **not** count toward the 10-budget limit. A restore is refused with `LIMIT_REACHED` when the owner is already in 10 non-deleted budgets, or when any other member would exceed the **hard bound of 20** (F-37), without saying which member. `BudgetList.maxItems` is 20.
   - **The restore window ends when the owner's account is purged (F-35).** Soft-deleted budgets of a purged owner are hard-deleted with them, and the "account deletion scheduled" email says so.
3. **Race safety (F-25, F-35).** Account-deletion requests, invitation acceptance and ownership transfer each take `SELECT … FOR UPDATE` on the affected budget rows. The deletion request and the purge re-check use **one rule**: no **non-deleted** owned budget has another member. If the purge finds one, it skips the user and fails the run (alert).
4. **Owner tooling (admin-commands.md, Cloud Run jobs only):**
   - `revoke-sessions --all --restore` for the post-restore procedure (F-11). Restore mode also deletes `email_change_cancel` tokens. The user notice is sent manually by the owner (BCC) until a CLI command exists.
   - A read-only `security-events --user-id` for incident response (F-26).
   - `rewrap-mfa [--dry-run]` for `APP_KEYRING` rotation (data-model.md "Application keyring"), and `rewrap-mfa --retire-recovery-codes <keyId>` to delete recovery codes under a burned key and notify the affected users (F-38).
   - No command reads or edits financial data.

## Alternatives considered
- **Admin `restore-budget` command (F-14 as written):** works, but needs the owner to notice, then run a job. Self-service is faster and keeps the operator out of household data (owner's choice, OD-5).
- **Automatic transfer to the longest-standing member when the owner deletes their account:** surprising, and it gives power without consent from either side.
- **Transfer with acceptance by the new owner:** adds an invitation-like state machine for a rare action at fewer than 10 users. Notification covers the visibility concern.
- **Hard delete for budgets:** would remove the undo that OD-5 asks for.
- **Ad-hoc SQL for incident response:** error-prone, and outside the admin-command principles.

## Consequences
- **API:** three new operations. **Data:** row locks, the purge re-check, `requireDeletedBudgetOwnership`, and limit counting over non-deleted budgets only. **Emails:** more notifications, all of them priority mail (auth.md §15).
- **frontend:**
  - an owner-only "Transfer ownership" action in the members screen
  - a "Recently deleted" list with Restore
  - the re-auth dialog on transfer
- **tests:**
  - transfer then leave
  - transfer then delete account
  - restore within and after the window
  - a non-owner, former member or current member restore returns 404
  - restore at the 10-budget limit returns `LIMIT_REACHED`
  - an owner who soft-deletes a shared budget and then gets purged: the budget is hard-deleted and the purge run passes
  - concurrent deletion request vs acceptance
- **sre:** a runbook entry for the post-restore sequence: `revoke-sessions --all --restore`, then `purge`, then the manual BCC notice.
- **ci:** the Semgrep allowlist names `requireDeletedBudgetOwnership` as the only other place that may construct a scope type.
- Co-member trust is unchanged (R-4): a member can still alter or soft-delete transactions. Per-transaction restore is not in the MVP.
