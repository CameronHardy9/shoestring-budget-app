# Admin commands
Owner: architect. Implemented by backend-engineer (`backend/`), run and scheduled by sre and the owner per docs/runbooks/, reviewed by security-reviewer.
Revision 2 (2026-11-13): OD-3, F-02, F-11, F-26. Revision 3 (2026-11-13): R-12, the restore mode of `revoke-sessions` (F-11 note), `rewrap-mfa` (keyring rotation), and backups as a separate job. Revision 4 (2026-11-13): `rewrap-mfa --retire-recovery-codes` (F-38) and the comma rule for emails (F-02 note).

Owner admin powers are **CLI commands, not HTTP endpoints**. They ship in the production image as `dist/admin.js`, which is built from the same source and version as `dist/server.js`.

## Where they run (OD-3, F-02)
- **Only as Cloud Run jobs in the private production project**, started by the owner from the authenticated `gcloud` CLI or the console, for example `gcloud run jobs execute shoestring-admin --region us-east1 --args=reset-mfa,--email=…`.
- **`purge`** runs as the separate job `shoestring-purge`, triggered daily by Cloud Scheduler.
- They **never** run in GitHub Actions: the repository, its run logs and its dispatch inputs are public.
- Secrets stay in Secret Manager.
- **Target emails stay in `--args` (accepted residual R-12, owner 2026-11-13):** the job execution record and Cloud Audit Logs keep the arguments, including a target email, inside the owner-only GCP project for about 400 days. No input-secret mechanism (e.g. an `ADMIN_TARGET_EMAIL` secret) is used. The command's own output never repeats the email. **The privacy notice must disclose this retention** (security-reviewer).
- **Backups are not an admin command.** The nightly `pg_dump` runs as its own Cloud Run job, `shoestring-backup`, with its own minimal image and the `backup` role (ADR-0007 constraint 10).
- Locally: `pnpm --filter backend admin <command>` against the compose database.

## Common rules
- **Least config (F-02):** each command loads and validates **only** the variables it needs. Each Cloud Run job definition mounts only those secrets.

  | Command | Needs |
  |---|---|
  | `purge`, `revoke-sessions`, `security-events` | `DATABASE_URL` |
  | `create-signup-invite`, `reset-mfa` | `DATABASE_URL`, `APP_ORIGIN`, `EMAIL_*` |
  | `rewrap-mfa` | `DATABASE_URL`, `APP_KEYRING`; with `--retire-recovery-codes` also `APP_ORIGIN`, `EMAIL_*` |

  No other command needs `APP_KEYRING`, and none needs `MIGRATOR_DATABASE_URL`. Recommendation to sre: `rewrap-mfa` gets its own job definition (`shoestring-rewrap-mfa`), so that `shoestring-admin` never mounts the keyring.
- **Email arguments (F-02 note):** gcloud joins `--args` with commas, so the CLI **rejects any `--email` value that contains `,`** with exit 2 (usage error), before any database access. Emails are not unescaped or split in any other way.
- **Output never contains emails, tokens or links** (F-02). Commands print opaque IDs (user ID, invite ID), expiries, and counts. Each run writes JSON log lines in the server's format with a generated `requestId`, command name, outcome and counts.
- **Confirmation without a terminal:** Cloud Run jobs are not interactive. Destructive commands therefore run in two steps:
  1. Run without `--yes`: a dry run that prints the resolved user ID and what would change.
  2. Re-run with `--yes --expect-user-id <id>`. The command refuses (exit 4) if the ID does not match.

  `purge` is idempotent and takes `--yes` alone.
- **Exit codes:** `0` success · `2` usage error · `3` target not found or not eligible · `4` refused by a safety rule · `1` unexpected error.
- Every successful action writes a `security_events` row (`admin_*`), except `security-events`, which only reads.

## Commands
| Command | Flags | Effect | Exit 3 / 4 when |
|---|---|---|---|
| `create-signup-invite` | `--email <e>` | Creates a sign-up invite (7-day expiry), revokes any earlier open invite for the email, and emails the link. Prints the invite ID and expiry. | 4: an account with that email already exists |
| `reset-mfa` | `--email <e>` `[--yes --expect-user-id <id>]` | Deletes all TOTP and passkey factors, recovery codes and open one-time tokens, revokes all sessions, and emails the user. | 3: no such user · 4: user has no MFA, or ID mismatch |
| `revoke-sessions` | `--email <e>` `[--yes --expect-user-id <id>]` **or** `--all --yes [--restore]` | Revokes the user's (or **every** user's) sessions and deletes their open one-time tokens except `email_change_cancel` (F-01, F-11). **`--restore`** (post-restore mode, `--all` only) also deletes every `email_change_cancel` token, because a restored, already-used cancel token would otherwise be replayable (F-11 note). It sends no email; the owner notifies users manually by BCC (owner ruling, round 2). | 3: no such user · 4: ID mismatch, or `--restore` without `--all` |
| `rewrap-mfa` | `--dry-run` **or** `--yes` | Keyring rotation (data-model.md "Application keyring"). `--dry-run` prints, per key ID, the counts of `totp_credentials` and `recovery_codes` rows. `--yes` re-encrypts every TOTP secret not under `current` (same AAD = user_id) in batches, then prints counts. Recovery-code hashes cannot be rewrapped; the command reports how many remain on old keys. Idempotent.<br>**`--retire-recovery-codes <keyId>`** (F-38, for a burned key). Without `--yes` it is a dry run that prints the number of affected users and codes. With `--yes` it deletes every `recovery_codes` row whose `key_id` is `<keyId>`, records one `recovery_codes_retired` security event per affected user, and emails each affected user (priority) to regenerate their recovery codes. Their TOTP and passkey factors are untouched. Idempotent (a re-run finds 0 rows and sends nothing). This lets keyring stage 3 (removing the key) proceed without waiting for every user to regenerate. | 4: `<keyId>` is the keyring's `current` key, or has an invalid format |
| `security-events` | `--user-id <id>` `[--since <RFC 3339>]` | **Read-only** incident-response view (F-26), so the owner never needs ad-hoc production SQL. Prints `created_at, type, session_id, budget_id, device_browser, device_os, ip` for that user, newest first, at most 500 rows. IPs then sit in the job's Cloud Logging output for its 30-day retention (accepted with R-6). | 3: no such user |
| `purge` | `[--dry-run]` `--yes` | Runs data-model.md "Deletion and purge". Idempotent; prints counts per step only. A skipped user (F-25 re-check) makes the run exit 1 so the purge alert fires. `--dry-run` prints counts without deleting. | none |

## Owner runbook requirements (sre writes them; security-reviewer reviews)
- **`reset-mfa`:** assume the requester's mailbox may be compromised.
  - The owner verifies identity on a call or video call that **the owner** starts, using contact details known before the request, never ones supplied in it.
  - Record the date and the verification method.
  - The user re-enrolls MFA straight after the reset.
- **Restore from backup (F-11):**
  1. Restore.
  2. `revoke-sessions --all --yes --restore`.
  3. `purge --yes`.
  4. Only then reopen traffic.
  5. The owner emails all users by BCC: "data since <backup time> was restored; sign in again; check your members, MFA and password".
- **Keyring rotation:** the rotate-secret runbook (sre) follows data-model.md "Application keyring" and uses `rewrap-mfa`. After a suspected compromise of a key, the order is: make a new key `current` → `rewrap-mfa --yes` → `rewrap-mfa --retire-recovery-codes <burned keyId> --yes` → remove the burned key from the keyring (F-38).

## Not admin commands (by design)
Creating budgets for users, reading or editing financial data, changing a user's email or password, granting budget roles, and restoring budgets (owners do that themselves: ADR-0010). Any of these needs an ADR first.
