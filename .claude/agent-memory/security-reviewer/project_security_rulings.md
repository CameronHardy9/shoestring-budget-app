---
name: project-security-rulings
description: Security-reviewer rulings on Shoestring's MVP design (2026-11-12) and the reasons for each, so later reviews do not reopen or contradict them
metadata:
  type: project
---
Rulings I made in the 2026-11-12 contract review. The full text is in docs/security/THREAT_MODEL.md "Open risks" and FINDINGS.md.

- **Optional MFA** was accepted by the owner on 2026-11-12, against my recommendation (R-1). I still recommend requiring MFA for budget owners who share a budget (OD-1). Treat password compromise as the most likely attack and push detective controls (new-sign-in emails, notice on invitation acceptance).
  **Why:** owner chose beta friction over the risk. **How to apply:** don't re-argue the decision itself; judge each auth change by whether it stays safe when the attacker already has the password.
- **Backups in public-repo Actions artifacts: NOT accepted**, even encrypted (ADR-0007 constraint 7 needed my explicit acceptance; I declined).
  **Why:** any signed-in GitHub user can download them, public run logs leak, and there is a single key forever. **How to apply:** accept only private storage with a write-only credential and a read-only `backup` DB role.
- **RLS rejection (ADR-0006) accepted, on conditions.** Tooling must enforce the BudgetScope brand (Semgrep bans `as BudgetScope` and db/sql imports outside db/), foreign IDs in request bodies get a 400 before any FK fires, and idempotent replay and export go through the scope.
  **Why:** TS brands are compile-time only. **How to apply:** in every backend/db diff, check those rules exist and pass.
- **TOTP field encryption with MFA_ENCRYPTION_KEY: endorsed.** It does not conflict with the owner's "no field-level encryption"; it targets DB-only or backup-only leaks. Recovery codes must get the same protection (an HMAC with an HKDF subkey, not plain SHA-256).
- **security_events.ip kept 90 days:** recommended accepting it (R-6); app logs keep no IPs or UAs.
- **CSP:** `script-src` never relaxes. The only style relaxation I would sign off is `style-src-elem 'unsafe-inline'`, and only if React Aria can't replace the Radix parts that inject `<style>` elements.

- **Re-review 2026-11-13 deviation rulings (all accepted):**
  1. F-22 inline send with a 700 ms timeout and a fixed 1 s response (Cloud Run throttles CPU after the response).
  2. The cancel link reverts confirmed changes within 24 h. Residual R-11; F-33 must be fixed first.
  3. Admin arguments stay in private GCP records (R-12; Admin Activity logs may keep them ~400 days).
  4. Reset mail is non-priority.
  5. Ownership transfer has no acceptance step.
  6. `security-events` IPs in 30-day logs (under R-6).

  OD-1 kept MFA optional for owners too; OD-7 accepted R-4, R-5, R-6, R-8 and R-10; OD-8 left legal unassessed.
  **Why:** these are settled, so don't relitigate them. **How to apply:** in code review, check the conditions attached to each ruling instead.

- **Clearance 2026-11-13 (third pass):**
  - Contracts **cleared for owner approval**; F-33 and F-34 fixed; R-11 and R-12 owner-accepted 2026-11-13.
  - Accepted the single `APP_KEYRING` (HKDF subkeys, per-row key_id, rewrap job), `LIMIT_REACHED` on restore, and `deleted_budget_owner` + `DeletedBudgetScope`.
  - Backups moved to a Cloud Run job, so no DB credential or app key enters GitHub.
  - Open Low: F-37 (BudgetList maxItems 10 vs restore overflow).
  - `make audit` became real (gitleaks, semgrep, osv-scanner, zizmor); the project-specific Semgrep rules (BudgetScope cast, `_test` sentinel) still need code to exist.

Related: [[project-review-hotspots]]
