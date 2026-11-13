---
name: migration-pitfalls
description: Postgres/dbmate traps hit while building Shoestring's schema (PL/pgSQL field resolution, cascade vs RESTRICT, down-migration order, lib/pq sslmode)
metadata:
  type: project
---

Traps found while writing the initial migrations (2026-11-13); all are now covered by tests in db/src.

- PL/pgSQL plans a whole condition, so `IF TG_TABLE_NAME = 'x' AND OLD.col ...` fails with "record old has no field" when the trigger fires on another table. Use nested IFs in shared trigger functions.
- A budget hard delete cascades to categories and to transactions -> splits as separate internal statements. RESTRICT or immediate NO ACTION on splits -> categories fails mid-cascade. Fix used: `DEFERRABLE INITIALLY DEFERRED` FK, and `SET CONSTRAINTS ... IMMEDIATE` in deleteCategory to keep RESTRICT-like behaviour (contract says RESTRICT).
- Down sections must drop tables before the trigger functions they use (2BP01 otherwise).
- dbmate uses lib/pq, which defaults to sslmode=require; local/CI URLs have no sslmode, so the migrate CLI adds sslmode=disable for local hosts only.
- RI cascades run as the referencing table's owner, so `users` -> `security_events` ON DELETE CASCADE works although `app` has no DELETE there (tested).
- Bulk-loading test data: `SET LOCAL session_replication_role = replica` as superuser skips the deferred split triggers.

**Why:** each cost a debugging round; the contract's literal wording (RESTRICT) does not work with its own cascade rules.
**How to apply:** check these before writing new triggers, FKs with cascades, or down sections. Related: [[schema-conventions]].
