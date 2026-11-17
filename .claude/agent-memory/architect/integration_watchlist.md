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
- Owner-status rule (data-model "Lock order"): after a budget FOR UPDATE, user status must be re-read in a *later* statement. A status read joined into the locking statement is stale in READ COMMITTED when the other tx only locked the row (found in restore, 2026-11-14).
- Email `kind` vocabulary and link paths are a closed list in auth.md §15; diff backend `EmailKind`/`LINK_PATHS` against it.
- CSP `style-src` carries two React Aria sha256 hashes (owner ruling 2026-11-14). Backend header vs frontend `STYLE_SRC` must match; test-engineer owns the cross-area comparison test. Rejected: `style-src-elem` split (Safari 15.4+, no gain), `'unsafe-inline'`, nonces.
- `x-error-codes` lists every operation-specific cause, even when an implicit rule already allows the code (e.g. reauth's MFA_REQUIRED = missing factor, not pending session; added 2026-11-16 with completePasswordReset's). Prose-vs-list scan: parse the YAML with node + `node_modules/.pnpm/yaml@*/node_modules/yaml`, regex ErrorCode enum names in summary+description, diff against x-error-codes ∪ implicit set. tests/support/contract.ts `PROSE_CODES` should stay empty.
- Email budget has two threshold sets, often conflated: 60% = bulk mail cutoff (mailer), 80%/100% = Sentry A6 alerts. Sentry: no per-key rate limit (paid), alerts reach the phone via Gmail push (owner, 2026-11-16).
- Split→category FK is deferred NO ACTION (purge cascade); a quick-add racing a category delete fails at COMMIT with 23503 → must be 500 INTERNAL via the F-07 allowlist serializer, never `detail`.

Recurring drift: sre docs lag on env var names (rev 2 renamed DATABASE_MIGRATOR_URL→MIGRATOR_DATABASE_URL, RELEASE→APP_RELEASE) and on DMARC target (p=reject). Grep infra/ and docs/runbooks/ after any config rename.

Validation recipe: no global validator and no PyYAML. A scratch-venv `pip install openapi-spec-validator` was denied by the auto-mode classifier (2026-11-13); fallback is `pnpm exec prettier --check <file>` (syntax error → `[error]`, style only → `[warn]`). `make check`'s Prettier does NOT cover docs/; contract files were already unformatted at HEAD, so don't reformat them (diff churn). Re-create the lint (x-error-codes→status map from errors.md; explicit role/reauth; list-valued `x-rate-limit` rows must exist in auth.md §14). Prettier (format hook) rewrites YAML after Edit — use scripted edits (python3 via Bash) for the OpenAPI file. Shell default Node is 20 (nvm); run backend vitest with `PATH=$HOME/.nvm/versions/node/v24.22.3/bin:$PATH` from backend/. `src/contract/contract.test.ts` checks contract.gen freshness; info.description is not part of the codegen.

Email-quota A6 thresholds (F-60, 2026-11-17: warning 60%, error 100%) are copied in 4 places outside contracts: backend/src/email/mailer.ts (share + fixed `email_quota_threshold: N%` message), observability/README.md A6, docs/runbooks/email-quota.md, runbooks/README.md. A threshold change in auth.md §14 must be routed to all of them.

**Why:** these are where areas meet and drift silently.
**How to apply:** start every integration review with this list, then `git diff`. Related: [[project-mvp-contracts-v1]].
