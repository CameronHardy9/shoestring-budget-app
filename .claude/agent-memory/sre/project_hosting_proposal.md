---
name: project-hosting-proposal
description: Accepted Shoestring hosting (Cloud Run us-east1 + Neon free + Cloudflare DNS) and the owner's round 2/3 ops rulings (2026-11-12/13); non-obvious Cloud Run/GCS pitfalls
metadata:
  type: project
---

**Accepted by the owner 2026-11-12, refined 2026-11-13** (docs/mvp-planning/10-contract-review-decisions.md, "Round 2"):
- Cloud Run (us-east1, request-based, max 2 instances) + Neon free (aws-us-east-1) + domain mapping. DNS on Cloudflare stays grey-cloud.
- The Cloudflare proxy fallback is switched on **only after a security-reviewer review**.
- Spend cap is the hard cap (kill switch is fallback only). R1 accepted.
- Backups are a **Cloud Run job `shoestring-backup`** (small pinned alpine+pg_dump+age image, deploy/backup/backup.sh, objectCreator-only on a bucket in a separate project). There is no GitHub backup workflow or environment, and no DB credential in GitHub.
- Admin commands are Cloud Run jobs with the email in `--args` (R-12 accepted; the input-secret idea was rejected).
- `APP_KEYRING` replaced MFA/throttle keys and is mounted only on the service and `shoestring-rewrap-mfa`.
- 5 Secret Manager secrets, so one free slot is spare.
- Env names are `MIGRATOR_DATABASE_URL` and `APP_RELEASE`. DMARC ramps to `p=reject` before launch. V26 (hop count) is a launch blocker.
- As of 2026-11-13 nothing is created in the cloud. bootstrap-production.md is the setup order.

**Why:** the owner's hard $0/month plus "cold start a few seconds"; the security reviewer pushed DB credentials out of the public repo's CI.

**How to apply:** check ADR-0007 and the contracts (admin-commands.md, data-model.md "Application keyring") before changing ops docs. The architect ratifies names, so don't invent env/secret names. The blocking verify items are in infra/hosting-evaluation.md (V0, V1–V3, V7, V9, V23, V26).

Non-obvious pitfalls found (keep in mind on any Cloud Run work here):
- Firebase Hosting rewrites pass only a cookie named `__session`, which breaks the `__Host-ss_sid` auth cookie.
- Deleting the image of a serving Cloud Run revision (or a job) stops new instances from starting, so AR cleanup keeps `prod-*` tags.
- Cloud Run platform request logs contain IP/UA (forbidden by the logging policy), so they are excluded from `_Default`.
- Excluding `severity<INFO` would drop DEFAULT-severity (unparsed) app logs.
- GCS soft delete (7 days by default) would break "backups expire within 35 days".
- gcsfuse and gcloud need more than objectCreator. A JSON API simple upload with `ifGenerationMatch=0` needs only `storage.objects.create`.
- `gcloud run jobs` `--args` and overrides are kept in execution records and Admin Activity audit logs (~400 days).
- zsh doesn't word-split unquoted `$files`; use xargs when scripting edits.
Related: [[owner-constraints]]
