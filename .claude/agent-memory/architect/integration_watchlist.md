---
name: integration-watchlist
description: Drift risks to check first in Shoestring integration reviews, recurring cross-area naming drift, and how to validate/lint the OpenAPI contract locally
metadata:
  type: project
---

Check these first in integration-review mode:
- Route table built from api.openapi.yaml extensions; every op has explicit `x-budget-role` (none|member|owner) and `x-reauth` (true|false); `{budgetId}` paths must be budget-scoped (deleted-budget restore uses `{deletedBudgetId}` on purpose).
- Zod vs contract (generated types fresh); responses `additionalProperties: false`.
- Every unsafe method can 403 CSRF_FAILED; Host check exempts only /api/healthz and /api/readyz.
- Test hooks only in backend/src/dev-server.ts; `/_test/` grep on dist; NODE_ENV fail-closed; origin tripwire.
- App clock injectable; no DB now() in rules.
- Error serializer allowlist (no pg `detail`); Sentry scrubbing settings.
- user_tokens deletion on every revocation event (except email_change_cancel); split-sum and one-owner deferred triggers; FOR UPDATE locks on deletion/accept/transfer.
- Split→category FK is deferred NO ACTION (purge cascade); a quick-add racing a category delete fails at COMMIT with 23503 → must be 500 INTERNAL via the F-07 allowlist serializer, never `detail`.

Recurring drift: sre docs lag on env var names (rev 2 renamed DATABASE_MIGRATOR_URL→MIGRATOR_DATABASE_URL, RELEASE→APP_RELEASE) and on DMARC target (p=reject). Grep infra/ and docs/runbooks/ after any config rename.

Validation recipe: no global validator and no PyYAML. A scratch-venv `pip install openapi-spec-validator` was denied by the auto-mode classifier (2026-11-13); fallback is `pnpm exec prettier --check <file>` (syntax error → `[error]`, style only → `[warn]`). `make check`'s Prettier does NOT cover docs/; contract files were already unformatted at HEAD, so don't reformat them (diff churn). Re-create the lint (x-error-codes→status map from errors.md; explicit role/reauth; list-valued `x-rate-limit` rows must exist in auth.md §14). Prettier (format hook) rewrites YAML after Edit — use scripted edits or re-read before editing.

**Why:** these are where areas meet and drift silently.
**How to apply:** start every integration review with this list, then `git diff`. Related: [[project-mvp-contracts-v1]].
