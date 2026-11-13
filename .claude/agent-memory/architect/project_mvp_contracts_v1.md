---
name: project-mvp-contracts-v1
description: State of the Shoestring MVP contracts (rev 3, 2026-11-13) — owner rulings applied, which ADRs are still Proposed, open owner questions
metadata:
  type: project
---

Contracts rev 1 written 2026-11-12; rev 2 on 2026-11-13 applied the owner's rulings (docs/mvp-planning/10-contract-review-decisions.md) and security findings F-01..F-31. Owner rulings are binding there; check that file before re-litigating anything.

Settled by owner (don't reopen): income/refunds stay; members manage categories; ownership transfer exists; limits accepted; MFA optional for everyone incl. owners (OD-1); 90-day absolute session cap (OD-2); admin commands = Cloud Run jobs only (OD-3); self-service budget restore (OD-5); hosting = Cloud Run us-east1 max 2 + Neon, spend cap, Cloudflare DNS (ADR-0007 Accepted); pnpm 10.34.9 (ADR-0008).

Rev 3 (2026-11-13): F-33/F-34 blocking fixes; owner round-2 rulings in mvp-planning/10 "Round 2" (ADR-0009 and ADR-0010 fully Accepted; soft-deleted budgets don't count toward limit, restore → LIMIT_REACHED; backups = Cloud Run job, no DB creds in GitHub; R-11, R-12 accepted; no ADMIN_TARGET_EMAIL). Keys merged into one versioned `APP_KEYRING` (HKDF subkeys) replacing MFA_ENCRYPTION_KEY/THROTTLE_KEY; `rewrap-mfa` command; new role value `deleted_budget_owner` + `DeletedBudgetScope`. Remaining architect deviation from security text: F-22 inline send with fixed 1 s pad (no post-response queue).

Data-layer reconciliation (owner-approved 2026-11-13): split→category FK deferred NO ACTION; expired pending invitation replaced on re-invite; invitation limits count unexpired only; transfer to pending-deletion member = NOT_FOUND; email-change cancel outcome = (current email == token address ? cancelled : reverted), confirm may reissue a cancel token; DB expiry CHECKs. Accepted ADRs are amended via an appended `## Amendments` section (first used on ADR-0010), never rewritten.

**Why:** the owner approves contracts; future rounds must know what is decided vs proposed.
**How to apply:** in integration review treat Accepted items as contract; ask before changing Proposed ones. See [[integration-watchlist]].
