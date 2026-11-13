# Runbooks
Owner: sre. One file per alert and per routine operation. Platform accepted by the owner on 2026-11-12 (Cloud Run + Neon, DNS on Cloudflare). Status: **drafts pending the first deploy.** No command in these runbooks has been run against production yet. Start with [bootstrap-production.md](bootstrap-production.md).

Each runbook has: **When to use** · **Steps** (exact commands) · **Verify** · **Back out**

Production commands are run by the **owner** only. Agents prepare them.

## Targets
| Target | Value | Notes |
|---|---|---|
| **RPO** | **24 hours** | Nightly encrypted dump. Owner-accepted risk (2026-11-12). Neon's free restore window (length unverified, V8) can sometimes do better for recent mistakes, but we never count on it. |
| **RTO** | **4 hours** (best effort) | From "decide to restore" to the app serving restored data. Measured in each restore drill. |
| Backup retention | Deleted at **34 days** by lifecycle (always gone within 35) | Purged user data is gone everywhere within 30 + 35 days (data-model.md "Deletion and purge"). |
| Availability | Best effort; SLO "record a transaction succeeds" 99.5% / 30 days | Defined in docs/ARCHITECTURE.md |

## Restore drill record
A restore drill must pass **before launch** and then every quarter, and after any change to the backup workflow or the Postgres major version.
| Date | Backup restored (object name) | Target | Time to restore (RTO evidence) | Row-count check | Result | By |
|---|---|---|---|---|---|---|
| _not yet run, required before launch_ | | | | | | |

**Last successful restore test: _never_** (update restore.md's header too).

## Backup design
**A nightly encrypted `pg_dump` run as a Cloud Run job in the prod project, written to a private Cloud Storage bucket in a separate GCP project** (owner ruling 2026-11-13, F-17). The database credential never enters GitHub.

```
Cloud Scheduler "shoestring-backup-nightly" (15 9 * * * UTC; 2nd of 3 free scheduler jobs)
  → Cloud Run Job "shoestring-backup" (backup image, SA shoestring-backup@, --max-retries 1)
      deploy/backup/backup.sh:
        pg_dump --format=custom  (read-only "backup" role from Secret Manager, Neon direct endpoint, verify-full)
          | age --encrypt --recipient <public key>     # plaintext exists only inside this pipe
          > /tmp/<random>                              # ciphertext only; /tmp is in-memory on Cloud Run
        POST to the GCS JSON API (create-only: ifGenerationMatch=0) with the job SA's metadata-server token
          → gs://shoestring-backups-<suffix>/daily/shoestring-<UTC timestamp>.dump.age
      → success: ping the Better Stack heartbeat; failure: ping its /fail URL
```

### Why these choices
| Choice | Reason |
|---|---|
| **Cloud Run job, not GitHub Actions** (owner ruling) | The read-only DB credential stays in Secret Manager, readable only by `shoestring-backup@`. Nothing about backups touches the public repo, its logs or its artifacts. Cloud Scheduler is punctual and is never disabled for inactivity, unlike Actions cron. |
| **A small dedicated backup image** (not the app image) | It is a pinned `alpine` base with `bash`, `postgresql17-client`, `age`, `curl` and `ca-certificates`, a non-root user, and entrypoint deploy/backup/backup.sh. ci-engineer builds it from `Dockerfile.backup` in the same CI pipeline, scans it and pushes it to GHCR; it is copied to AR by digest like the app ("same artifact, never rebuilt").<br>Reasons: (1) `pg_dump` and `age` don't belong in the internet-facing app image. (2) The backup is decoupled from app releases, so a bad app deploy can't break backups. (3) It is ~20 MB against AR's 0.5 GB free storage. (4) `pg_dump` must be major 17+, pinned independently of Node. |
| **Upload with `curl` to the JSON API** (no gcloud or gcsfuse) | The `gcloud` SDK image is hundreds of MB, and gcsfuse needs read and list permissions. A simple media upload with `ifGenerationMatch=0` needs only `storage.objects.create`, which is exactly `objectCreator`. |
| **Cloud Storage** (not Cloudflare R2) | Keyless (metadata-server token), covered by the budget alerts and cap, and 5 GB-month free in us-east1 (~25× our need). R2 would need a static access key and a card on an uncapped account. |
| **Separate project** `shoestring-backup-<suffix>` | The prod-project identities have create-only access to the bucket. Only the owner can read or delete. The database is on Neon, so backups already sit with a different provider from the data. |
| **Job SA `shoestring-backup@`; deployer scoped away from the backup job** (F-39) | The deployer identity (GitHub OIDC) has `roles/run.developer` **only on the service and the migrate, purge, admin and rewrap-mfa jobs**, plus a minimal custom project role (bootstrap steps 5 and 12h). It has no role on `shoestring-backup` and no actAs on `shoestring-backup@`. **With that scoping in place**, a compromised deploy can't run, override, update or delete the backup job, so it can't redirect the dump. The restore runbook also checks each dump's provenance (restore.md step 2). The owner updates the backup job's image by hand (rare). |
| **`age` with a public recipient key** | The job only ever holds the **public** key (plain env), so nothing in GCP can decrypt a backup. The private key is held offline in **two places** (vault A plus one offline copy). The `APP_KEYRING` escrow copy is in a **separate** vault (B), never with backups (F-17). |
| **Read-only `backup` role** on the **direct** endpoint | `pg_dump` needs a session-level connection (not the pooler). SELECT only, never `app` or `migrator` (F-17; data-engineer creates it). URL has `sslmode=verify-full&sslrootcert=system` (F-28). |
| **Write-only storage credential** | `roles/storage.objectCreator` on the bucket: no read, list or delete, so a compromised job can neither read nor wipe backups. Create-only uploads can't overwrite an existing object either. |
| **`--format=custom`, `--no-owner --no-privileges`** | Compressed and selectively restorable. Ownership and grants are reapplied from db/roles.sql on restore. |
| **Lifecycle delete at 34 days, soft delete off** | Lifecycle runs can lag up to 24 h, so 34 days keeps us inside 35. Soft delete would keep deleted dumps 7 more days. |
| **Heartbeat** (alert A4) | Any failure, or a job that never starts (scheduler paused, spend cap reached, image missing), shows as "backup missed" within 26 h. |
| **09:15 UTC, after the 08:00 purge** | Each backup already reflects the day's purge. |
| **Logs** | JSON lines with the object name and byte count only. Never the URL, token, row counts or dump content. |

Encryption at rest: Neon's disk encryption (provider), Cloud Storage's default encryption, plus `age` end to end.

### Image spec for ci-engineer (`Dockerfile.backup`)
- Base `alpine:<3.x>@sha256:<digest>` (pinned; Dependabot docker updates).
- `apk add --no-cache bash postgresql17-client age curl ca-certificates`. The client major must be ≥ Neon's server major (17).
- Copy `deploy/backup/backup.sh` to `/usr/local/bin/backup.sh`, mode 0755. Non-root `USER 10001`. `ENTRYPOINT ["/usr/local/bin/backup.sh"]`.
- Build in the main CI pipeline, scan it like the app image, and push to `ghcr.io/<owner>/<repo>-backup:sha-<sha>`. Rebuild only when `deploy/backup/` or `Dockerfile.backup` changes (or for base-image updates).
- **No GitHub backup workflow** (`backup.yml` is cancelled). CI never holds a DB credential.

## Purge scheduler design
| Item | Design |
|---|---|
| Scheduler | **Cloud Scheduler** job `shoestring-purge-daily`, `0 8 * * *` UTC (1st of 3 free jobs; `shoestring-backup-nightly` is the 2nd, leaving 1 spare) |
| Runs | Cloud Run Job `shoestring-purge`: the **same image** as the service, command `node dist/admin.js purge --yes`, its own service account `shoestring-purge@` with **`DATABASE_URL` only** (F-02). Output and logs are **counts only** (OD-3). |
| Why not GitHub Actions cron | It would copy a production database credential into GitHub, and its logs are public. It can also be delayed, or disabled after 60 days. Cloud Scheduler keeps the secret in GCP. Other admin commands **never** run in GitHub Actions (OD-3). |
| Image kept current | The deploy updates the job's image to the new digest right after traffic moves (deploy.md step 6). |
| Idempotent | Yes (admin-commands.md), so a retry or a manual re-run is safe. `--max-retries=1`. |
| Monitoring | Sentry cron monitor `purge` (the backend wraps the command in a check-in): it alerts if the run is missing (> 26 h) or fails. Exit codes ≠ 0 also show as failed executions in the Cloud Run console. |
| Manual run | `gcloud run jobs execute shoestring-purge --region us-east1 --project "$PROJECT" --wait` · dry run: `--args="purge,--dry-run,--yes"` |
| Fallback (if Cloud Scheduler is unavailable) | The owner runs the job by hand (manual run above) until the scheduler is back. No GitHub Actions path: one fewer identity with job-execution rights. |

## Runbook index
| Runbook | Purpose | Status |
|---|---|---|
| [bootstrap-production.md](bootstrap-production.md) | One-time setup: operator MFA (F-03), projects, IAM, WIF, Neon, secrets, GitHub environments, email + DMARC, first deploy, hop-count probe (F-08), domain mapping on Cloudflare, launch checks | Draft. Steps 1–11 runnable now; 12+ need the app |
| [billing-protection.md](billing-protection.md) | Budgets, spend cap (kill switch fallback), quotas, registry cleanup, log limits, Neon limits, monthly free-tier check | Draft, run inside bootstrap |
| [deploy.md](deploy.md) | Deploy a release (migrate → no-traffic revision → readiness and F-10 gate → shift traffic) | Draft, pending first deploy |
| [rollback.md](rollback.md) | Move traffic back to the previous revision in one command | Draft, rehearse after the second deploy |
| [restore.md](restore.md) | Neon point-in-time or nightly-dump restore, then the post-restore revocation (F-11); restore drill. Last tested: **never** | Draft, drill required before launch |
| [rotate-secret.md](rotate-secret.md) | Rotate any credential, including the `APP_KEYRING` (add key → rewrap → remove, gated by readyz) | Draft; keyring section needs backend support |
| [admin-commands.md](admin-commands.md) | Owner admin commands as Cloud Run jobs (`shoestring-admin`, `shoestring-rewrap-mfa`); target email in `--args` (R-12 accepted); two-step confirmation; IDs and counts only (F-02); `reset-mfa` identity check; `security-events` | Draft, needs the backend CLI |
| [site-down.md](site-down.md) | Alert A1: `/api/healthz` failing | Draft |
| [error-spike.md](error-spike.md) | Alert A2: Sentry error spike | Draft |
| [purge-failed.md](purge-failed.md) | Alert A3: purge cron monitor missed or failed | Draft |
| [backup-missed.md](backup-missed.md) | Alert A4: `shoestring-backup` job heartbeat missing or failed | Draft |
| [billing-alert.md](billing-alert.md) | Alert A5: budget threshold crossed or spend cap reached | Draft |
| [email-quota.md](email-quota.md) | Alert A6: daily email sends at 80% / 100% of quota (F-09) | Draft, needs backend counter |
| breach-response.md | Outline for suspected data exposure (with security-reviewer) | Planned |
| phone-debugging.md | Safari Web Inspector / chrome://inspect against `make dev` (test hooks off on the LAN, F-30) | Planned, after ci-engineer's LAN binding |

Alert definitions and tool settings: [observability/README.md](../../observability/README.md).

incidents/ holds blameless postmortems: timeline, impact, root cause, what went well, what to change, owners.
