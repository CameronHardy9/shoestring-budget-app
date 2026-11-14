---
name: migration-pitfalls
description: Postgres/dbmate traps hit while building Shoestring's schema (PL/pgSQL field resolution, cascade vs RESTRICT, down-migration order, lib/pq sslmode, check-before-lock races)
metadata:
  type: project
---

Traps found while writing the initial migrations (2026-11-13); all are now covered by tests in db/src.

- PL/pgSQL plans a whole condition, so `IF TG_TABLE_NAME = 'x' AND OLD.col ...` fails with "record old has no field" when the trigger fires on another table. Use nested IFs in shared trigger functions.
- A budget hard delete cascades to categories and to transactions -> splits as separate internal statements. RESTRICT or immediate NO ACTION on splits -> categories fails mid-cascade. Fix used: `DEFERRABLE INITIALLY DEFERRED` FK, and `SET CONSTRAINTS ... IMMEDIATE` in deleteCategory to keep RESTRICT-like behaviour (contract says RESTRICT).
- Down sections must drop tables before the trigger functions they use (2BP01 otherwise).
- dbmate uses lib/pq, which defaults to sslmode=require; local/CI URLs have no sslmode, so the migrate CLI adds sslmode=disable for local hosts only.
- RI cascades run as the referencing table's owner, so `users` -> `security_events` ON DELETE CASCADE works although `app` has no DELETE there (tested).
- Locking a row on one side of a race is not enough if the other side checks BEFORE taking that lock (2026-11-13: transferOwnership locking the target did not stop requestAccountDeletion, whose shared-budget check ran before its lockUser). Re-check after the lock with a plain read (READ COMMITTED gives a fresh snapshot per statement); don't take a budget lock after a user lock (inverts ADR-0010 order). Prove both interleavings with a gated dal.transaction + waitForLockWaiters, and mutation-test each half.
- Multi-statement reads that must agree (getMfaDetail: totp flag vs confirmedAt vs passkeys) run in a REPEATABLE READ read-only tx when not already in one; READ COMMITTED gives each statement its own snapshot.
- acceptInvitation vs the owner's deletion (reviewed 2026-11-13, forced-order tests added 2026-11-14): safe without an owner-row lock because every path changing owner, owner status or membership locks the budget first. Surprise: the forced-order tests also pass WITHOUT accept's budget FOR UPDATE (member insert's FK takes KEY SHARE on the budget; the deletion's invitation revoke waits on the invitation row lock); only the unforced concurrent test catches its removal (deadlock). runPurge locks user then owned budgets (inverse of ADR-0010); no cycle found, re-check if a path ever locks a budget then its owner.
- Counters that limit guesses (F-45) must be reserve-before-check: one `UPDATE ... WHERE n < limit RETURNING`, then fail (keep) or release (refund). Refuse to run them inside dal.transaction, or a rollback refunds the slot. Mutation-tested: read-then-write gives >5 grants in a 50-way burst (needs a second Dal with poolMax > 5).
- Changing a function used by CHECK constraints (CREATE OR REPLACE is_clean_text, F-48) does NOT re-validate existing rows: put a DO-block guard in the up section that counts violators and raises (counts only, no values).
- Test flake: pg Pool.end() resolves before its sockets close; DROP DATABASE WITH (FORCE) right after kills them and the pool re-emits 57P01 as an unhandled error. testing/dispose now waits for pg_stat_activity to clear first.
- Bulk-loading test data: `SET LOCAL session_replication_role = replica` as superuser skips the deferred split triggers.

**Why:** each cost a debugging round; the contract's literal wording (RESTRICT) does not work with its own cascade rules.
**How to apply:** check these before writing new triggers, FKs with cascades, or down sections. Related: [[schema-conventions]].
