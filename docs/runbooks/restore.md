# Restore the database
- Owner: sre · Runs: **owner** (only the owner holds the `age` private key) · Status: **DRAFT, pending first deploy**
- **Last successful restore test: never.** A drill must pass before launch (record it in README.md "Restore drill record").
- Targets: RPO 24 h · RTO 4 h (best effort)

## When to use
| Situation | Path |
|---|---|
| Bad data written recently (bad release, mistaken purge), and within Neon's free restore window (length unverified, V8) | **A. Neon restore window** |
| Older damage, or the window is not available | **B. Nightly dump into a new database** in the same Neon project |
| The Neon project or account is lost | **B**, into a **new** Neon project |
| Quarterly or pre-launch test | **C. Drill** |
Get the tech lead's agreement first: a restore loses everything written since the restore point (up to 24 h for path B).

## Safety rules for the decrypted data
- The dump holds every user's financial data. Decrypt only on your own Mac (FileVault on), stream straight into `pg_restore`, and never write the plaintext to disk, chat, tickets or GitHub.
- Put connection strings into variables with `read -s` so they don't land in shell history.

## A. Neon restore window (point in time)
1. Neon Console → project `shoestring` → **Branches** → `main` → **Restore** (labels may differ, verify).
2. Pick a timestamp just before the damage. Neon keeps the pre-restore state as a backup branch.
3. The connection strings don't change, so no secret update is needed.
4. **Run "After any restore" below** (F-11). A point-in-time restore also brings back revoked sessions and old passwords.
5. Verify as below, then delete the backup branch after 7 days (branch and storage limits).

Before step 1 of path A, close ingress the same way as path B step 1, so nobody writes during the restore.

## B. Restore a nightly dump
Dumps are written nightly at 09:15 UTC by the Cloud Run job `shoestring-backup` (README.md "Backup design") to `gs://shoestring-backups-<suffix>/daily/`. Only your Google account can read them, and only your `age` private key can decrypt them.
```sh
export PROJECT="shoestring-prod-<suffix>" REGION="us-east1"
export BACKUP_BUCKET="shoestring-backups-<suffix>"

# 1. Stop user traffic so nobody writes to the old database during the switch.
#    Expected: Better Stack raises "site down". Pause the monitor or acknowledge it.
gcloud run services update shoestring --ingress internal --region "$REGION" --project "$PROJECT"

# 2. Choose the dump (newest last), then CHECK ITS PROVENANCE (F-39) before trusting it
gcloud storage ls -l "gs://$BACKUP_BUCKET/daily/" | sort -k2 | tail -5
export OBJ="shoestring-<timestamp>.dump.age"
gcloud storage objects describe "gs://$BACKUP_BUCKET/daily/$OBJ" --format="value(creation_time,size)"
gcloud run jobs executions list --job shoestring-backup --region "$REGION" --project "$PROJECT" --limit 10 \
  --format="table(metadata.name,status.startTime,status.completionTime,status.succeededCount)"
gcloud logging read 'protoPayload.methodName:"RunJob" AND protoPayload.resourceName:"jobs/shoestring-backup"' \
  --project "$PROJECT" --freshness 40d --limit 40 --format="value(timestamp,protoPayload.authenticationInfo.principalEmail)"
#   Accept the object only if ALL hold:
#   - its creation time falls inside a SUCCEEDED execution's start–completion window;
#   - that execution was started by shoestring-scheduler@ (or by you, for a manual run you remember);
#   - its size is in line with the neighbouring nights.
#   Otherwise pick the previous night that passes, and tell the tech lead (possible poisoning).

# 3. The age private key, from your password manager, into a private temp file.
#    Handoff OFF and clipboard managers paused first (F-40). The trap removes the file even if you stop early.
umask 077; KEYFILE=$(mktemp); trap 'rm -P "$KEYFILE" 2>/dev/null || rm -f "$KEYFILE"' EXIT
pbpaste > "$KEYFILE"; pbcopy < /dev/null

# 4. Target database. In the Neon Console create database "shoestring_restore_<yyyymmdd>" on branch main
#    (or a new project for total loss). Copy its DIRECT connection string for the migrator role.
read -rs RESTORE_URL; export RESTORE_URL

# 5. Roles and grants (data-engineer's idempotent script, planned as db/roles.sql: verify the path)
psql "$RESTORE_URL" -v ON_ERROR_STOP=1 -f db/roles.sql

# 6. Restore: stream, decrypt, restore in one transaction
gcloud storage cat "gs://$BACKUP_BUCKET/daily/$OBJ" \
  | age --decrypt -i "$KEYFILE" \
  | pg_restore --no-owner --no-privileges --exit-on-error --single-transaction --dbname "$RESTORE_URL"

# 7. Re-apply grants on the restored objects, then check the audit-log protections survived (F-11, F-26)
psql "$RESTORE_URL" -v ON_ERROR_STOP=1 -f db/roles.sql
psql "$RESTORE_URL" -At -c "select has_table_privilege('app','public.security_events','INSERT'),
  has_table_privilege('app','public.security_events','SELECT'), has_table_privilege('app','public.security_events','UPDATE'),
  has_table_privilege('app','public.security_events','DELETE'), has_table_privilege('app','public.security_events','TRUNCATE')"
#   expect: t|t|f|f|f   (app has INSERT and SELECT only)
psql "$RESTORE_URL" -At -c "select pg_get_userbyid(proowner) from pg_proc where proname = 'purge_security_events'"
#   expect: migrator    (anything else: stop and tell the tech lead / data-engineer)

# 8. Sanity checks (counts only, no content)
psql "$RESTORE_URL" -At -c "select count(*) from users" \
  -c "select count(*) from budgets" -c "select count(*) from transactions" \
  -c "select max(updated_at) from transactions" -c "select max(version) from schema_migrations"
```
9. Point everything at the restored database. Add new versions of all three DB secrets and pin them on their consumers (rotate-secret.md steps 1–3). Ingress is internal, so the candidate URL is unreachable; pin directly with `gcloud run services update shoestring --update-secrets …` and check `/api/readyz` right after reopening.
   - `shoestring-database-url`: service, plus the purge, admin and rewrap-mfa jobs
   - `shoestring-migrator-database-url`: migrate job
   - `shoestring-backup-database-url`: backup job. **Don't forget this one**, or tonight's backup dumps the old database.
   - Same Neon project, new database: the roles and passwords are unchanged, so only the database name in each URL changes.
   - New Neon project: set all three passwords with `\password` (bootstrap-production.md step 8) first.
10. **Run "After any restore" below** (F-11) **before** reopening traffic.
11. Clean up: `rm -P "$KEYFILE"; trap - EXIT; unset RESTORE_URL KEYFILE`. Turn Handoff back on. Keep the old database for 7 days, then drop it.

## After any restore (paths A and B; F-11, reviewed by security-reviewer)
A restore brings back state you had deliberately removed: revoked sessions, old (possibly compromised) password hashes, removed members, removed MFA factors, and open reset, email-change and email-change-cancel tokens. The contract order is: restore → `revoke-sessions --all --yes --restore` → `purge --yes` → reopen traffic → notice by BCC. Time-based purges re-run correctly; event-based changes do not. With ingress still **internal**:
```sh
# 1. Revoke every session and delete every open one-time token, INCLUDING email_change_cancel tokens
#    (--restore: a restored, already-used cancel token would otherwise be replayable; F-11, admin-commands.md)
gcloud run jobs execute shoestring-admin --region "$REGION" --project "$PROJECT" --args="revoke-sessions,--all,--yes,--restore" --wait
# 2. Re-run the purge, so accounts and data that were due for deletion are deleted again
gcloud run jobs execute shoestring-purge --region "$REGION" --project "$PROJECT" --wait
# 3. Reopen traffic
gcloud run services update shoestring --ingress all --region "$REGION" --project "$PROJECT"
```
4. **Re-apply security actions taken after the restore point.** Check your private admin log (admin-commands.md) and any incident notes for actions after the restore timestamp: `reset-mfa`, member removals, revoked invites. Repeat each one. Ask affected users to change a password they changed after the restore point.
5. **Tell every user.** Owner ruling 2026-11-13: until a CLI command exists, you send it yourself from your own mailbox, with all beta users in **BCC**:
   > Subject: Shoestring was restored from a backup
   > We restored Shoestring's data as it was at <time, timezone>. Anything you entered after that needs re-entering. You have been signed out everywhere: please sign in again, and check your budget's members, your MFA settings and your password. If you changed your password after <time>, change it again now.
6. Note in the incident record that steps 1–5 were done, with times.

## C. Restore drill (before launch, then quarterly)
Run path B steps 2–8 against a **new Neon project `shoestring-drill`** (never the production project), with no change to production traffic or secrets. The "After any restore" steps are **not** run for a drill (nothing serves the drill database). Then:
- Time it from step 2 to the end of step 8 and record it as RTO evidence in README.md.
- Optionally run the app locally against the drill database, but **only with the production entrypoint**: the production image or `node dist/server.js`, with `NODE_ENV=production`, **no `TEST_HOOKS`**, and `DATABASE_URL` passed via a `read -rs` variable. **Never `make dev`**: its test hooks would act on real users' data (F-40).
- Delete the `shoestring-drill` project the same day. Remove the key file.
- Update "Last successful restore test" at the top of this file and in README.md.

## Verify
- `/api/readyz` returns 200; on your phone sign in and check that the month totals look right (J3).
- Row counts are within the expected range of the last known numbers; `max(updated_at)` is just before the restore point.
- Sentry shows no new errors for 15 minutes.
- Tell beta users which time window of entries may need re-entering (a restore from the nightly dump loses up to 24 h).

## Back out
Before reopening traffic: re-pin the previous secret versions (they still point at the old database) and reopen ingress. After reopening: the same, plus tell users (template above). The old database is untouched by path B.
