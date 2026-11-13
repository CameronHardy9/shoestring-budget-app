# Admin commands (owner only)
- Owner: sre · Runs: **owner** · Reviewed by: security-reviewer (F-02) · Status: **DRAFT, pending the backend CLI and first deploy**
- Contract: docs/contracts/admin-commands.md (revision 3). Decision OD-3: admin commands run as **Cloud Run jobs in the prod project**, **never** in GitHub Actions. The repo, its run logs and dispatch inputs are public.

## Rules (F-02, R-12)
1. **Where:** only `gcloud run jobs execute …` from your own authenticated terminal, or the Cloud Run console. Never from a workflow, a shared machine or a chat tool.
2. **The target email goes in `--args`** (accepted residual R-12, 2026-11-13).
   - Cloud Run keeps the arguments on the job execution record. Admin Activity audit logs keep them for about 400 days and can't be shortened (verify V34). Both are visible only inside the owner-only prod project.
   - The privacy notice discloses this. Never put anything else personal in arguments: no names, notes or reasons.
3. **Output:** the CLI prints and logs IDs, expiry times and counts only, never emails, tokens or links. If one ever appears in job output, stop and report it (backend bug, F-02).
4. **Least config, one job per need:**
   | Job | Commands | Secrets mounted |
   |---|---|---|
   | `shoestring-admin` | `create-signup-invite`, `reset-mfa`, `revoke-sessions`, `security-events` | `DATABASE_URL`, `EMAIL_API_KEY` (plus `APP_ORIGIN` and `EMAIL_*` as plain env) |
   | `shoestring-rewrap-mfa` | `rewrap-mfa` | `DATABASE_URL`, `APP_KEYRING` |
   | `shoestring-purge` | `purge` | `DATABASE_URL` |
   - `shoestring-admin` **never** mounts the keyring. No job but migrate has the migrator URL, and only `shoestring-backup` has the backup credential.
5. **Two-step confirmation** (jobs are not interactive). Destructive single-user commands (`reset-mfa`, `revoke-sessions --email`):
   - First run **without** `--yes`: a dry run that prints the resolved user ID and what would change.
   - Then run again with `--yes --expect-user-id=<id>`. The CLI refuses with exit 4 if the ID doesn't match.
6. **No retries:** `shoestring-admin` and `shoestring-rewrap-mfa` have `--max-retries 0`, so a failure never sends an email twice.

## Shared helpers
```sh
export PROJECT="shoestring-prod-<suffix>" REGION="us-east1"

job_run() {             # usage: job_run <job> <command> [flags...]   e.g. job_run shoestring-admin reset-mfa --email=a@example.com
  local job="$1"; shift
  local args
  args=$(IFS=';'; echo "$*")       # ';'-joined, with gcloud's custom-delimiter syntax below
  gcloud run jobs execute "$job" --region "$REGION" --project "$PROJECT" --args="^;^$args" --wait
}

job_output() {          # IDs and counts from the latest execution of <job>
  local exec
  exec=$(gcloud run jobs executions list --job "$1" --region "$REGION" --project "$PROJECT" \
         --limit 1 --format="value(metadata.name)")
  gcloud logging read "resource.type=\"cloud_run_job\" AND labels.\"run.googleapis.com/execution_name\"=\"$exec\"" \
    --project "$PROJECT" --limit 200 --order asc --format="value(jsonPayload.message,textPayload)"
}
```
Each job definition fixes the command as `node dist/admin.js` (bootstrap-production.md step 12), so `--args` holds only the subcommand and its flags. Use the `--flag=value` form.
- gcloud splits `--args` on commas by default. `job_run` therefore switches the delimiter to `;` with gcloud's `^;^` prefix, so a comma can never split an argument.
- The CLI also rejects any email containing `,` (contract, being added by the architect). Emails containing `;` aren't supported by `job_run`; none of our users has one.
- For hand-typed commands, use `--args="^;^reset-mfa;--email=a@example.com"`.

## create-signup-invite
**When:** inviting a new beta user (owner only; the beta is capped at under 10 users).
```sh
job_run shoestring-admin create-signup-invite --email=new.user@example.com
job_output shoestring-admin          # expect: invite ID and expiry (7 days); exit 0
```
**Verify:** exit code 0 and an invite ID. The user receives the email (Resend → Logs shows "delivered" without opening the content).
**Back out:** run it again for the same email to revoke and replace the invite. Unused invites expire after 7 days.
Exit 4 means an account already exists: add them to a budget from the app instead.

## reset-mfa (identity check first)
**When:** a user who enabled MFA has lost every factor **and** their recovery codes.

**Identity check (mandatory, F-02).** Assume the requester's mailbox may be compromised.
1. Do **not** act on the request message itself (email, text or chat), whatever it says.
2. **You start** a phone or video call to contact details you had **before** the request (your contacts, an old thread). Never use a number or link supplied in the request.
3. Confirm you recognise the person (voice or face) and that they made the request. If you can't reach them on known details, or anything feels off, **refuse**. Tell them in person later.
4. Keep a private record **outside the repo** (the repo is public), for example a note in your password manager titled "Shoestring admin log". Record:
   - date and time
   - opaque user ID (from the dry run)
   - verification method ("video call to number saved 2025")
   - who started the call (you)
5. Stay on the call until they have re-enrolled.

**Run (two steps):**
```sh
job_run shoestring-admin reset-mfa --email=verified.user@example.com
job_output shoestring-admin          # dry run: prints the user ID and the factors/sessions/tokens it would remove
export UID_CONFIRMED="<user ID printed above>"
job_run shoestring-admin reset-mfa --email=verified.user@example.com --yes --expect-user-id="$UID_CONFIRMED"
job_output shoestring-admin          # expect: counts removed; exit 0
```
**Then, on the call:**
1. The user signs in with their password.
2. They enrol a new passkey or TOTP straight away, and save the new recovery codes.
3. If their mailbox or password may be compromised, they change the password **while signed in** (re-auth), not by email reset.
4. You record the user ID in your private log.

**Verify:** the CLI wrote `admin_mfa_reset` (check with `security-events` below if in doubt), and the user confirms MFA is on again.
**Back out:** none. The factors are deleted and the user re-enrols.

## revoke-sessions (one user)
**When:** a user's device was lost or stolen, or you suspect a session was stolen.
```sh
job_run shoestring-admin revoke-sessions --email=user@example.com          # dry run: user ID and session count
job_run shoestring-admin revoke-sessions --email=user@example.com --yes --expect-user-id="<user ID>"
job_output shoestring-admin
```
**Verify:** the user is signed out everywhere and can sign in again. **Back out:** none needed; they sign in again.

## revoke-sessions --all (every user; F-11)
**When:** a suspected breach of the session table. **After a restore, use `--restore` instead** (restore.md).
```sh
job_run shoestring-admin revoke-sessions --all --yes              # every session plus open one-time tokens (except email_change_cancel)
job_run shoestring-admin revoke-sessions --all --yes --restore    # post-restore only: also deletes every email_change_cancel token
job_output shoestring-admin                                       # counts only
```
Neither sends email. After a restore, you send the notice yourself by BCC (restore.md).

## security-events (read-only incident view, F-26)
**When:** investigating one account (suspicious sign-ins, a reset request).
```sh
job_run shoestring-admin security-events --user-id="<user ID>" --since=2026-11-01T00:00:00Z
job_output shoestring-admin          # up to 500 rows: time, type, session, budget, device, IP
```
The output includes **IPs**, which stay in this execution's Cloud Logging output for the 30-day retention (accepted with R-6). Don't copy them out of GCP.

## rewrap-mfa (keyring rotation only)
Run only as part of rotate-secret.md "Application keyring", using `shoestring-rewrap-mfa`:
```sh
job_run shoestring-rewrap-mfa rewrap-mfa --dry-run      # counts per key ID
job_run shoestring-rewrap-mfa rewrap-mfa --yes          # re-encrypts TOTP secrets under `current`; idempotent
job_output shoestring-rewrap-mfa
```

## purge (manual)
Normally automatic (Cloud Scheduler, 08:00 UTC):
```sh
gcloud run jobs execute shoestring-purge --region "$REGION" --project "$PROJECT" --wait                                # real run
gcloud run jobs execute shoestring-purge --region "$REGION" --project "$PROJECT" --args="purge,--dry-run,--yes" --wait   # counts only
```
A run that skips a user (F-25 safety re-check) exits 1 on purpose, so alert A3 fires (purge-failed.md).

## Verify (all commands)
- `gcloud run jobs executions list --job <job> --region "$REGION" --project "$PROJECT" --limit 3` shows the run as succeeded.
- No email address or link appears in `job_output`. The email appears only in the execution's arguments, which is accepted (R-12).

## Back out
The commands are safe to repeat: create-signup-invite replaces the invite; revoke, reset and rewrap are idempotent. `security_events` shows what happened.
