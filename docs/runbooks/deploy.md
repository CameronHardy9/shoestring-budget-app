# Deploy a release
- Owner: sre · Runs: **owner** (approves the GitHub `production` environment, or runs the manual commands) · Status: **DRAFT, pending first deploy**
- Platform: Cloud Run `shoestring` in us-east1 (infra/CLAUDE.md). The first-ever deploy is in bootstrap-production.md (planned), because `--no-traffic` needs an existing service.

## When to use
To release a commit on `main` whose CI run is green. One release at a time. Avoid 08:00–09:30 UTC (purge and backup run then).

## Preconditions
- CI is green for the commit, and **both** images for that exact SHA exist in GHCR (linux/amd64, built by CI; never a build from a Mac):
  - app `ghcr.io/<owner>/<repo>:sha-<full sha>` (the service and the purge, admin and rewrap-mfa jobs)
  - migrate `ghcr.io/<owner>/<repo>-migrate:sha-<full sha>` (the `shoestring-migrate` job only)
  - GHCR paths are **lowercase**; the repo slug has capitals, so use `GH_REPO_LC` below.
  - Both packages are **public** (owner ruling 2026-11-17), so `crane` reads them with no GitHub credential (no `read:packages` token, no `crane auth login ghcr.io`). `UNAUTHORIZED` from GHCR means a package went private: stop and tell the tech lead.
  - Always the **same SHA** for both: the app's `/api/readyz` requires the newest migration its build ships with.
- Any migration in the release is **expand-only**: the currently serving version must keep working against the new schema (data-engineer's checklist). Otherwise stop; rollback would not be safe.
- **If the release changes `db/roles.sql`** (`git diff --stat <serving sha> <new sha> -- db/roles.sql` prints anything): run it as the database **owner** before step 3, from a clean checkout at the new SHA (`git switch --detach <new sha>`; then `git status --porcelain db/roles.sql` must print nothing, F-64), exactly as in bootstrap-production.md step 8 item 5 (`psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f db/roles.sql`; `unset OWNER_URL` afterwards). The migrate job re-runs it as `migrator` and fails closed if the owner's part (database grants, the F-44 revokes) is missing.
- `gcloud`, `jq` and `crane` are installed; `gcloud auth login` done; `gcloud auth configure-docker us-east1-docker.pkg.dev` done once.

## Steps: normal path (GitHub Actions)
```sh
gh workflow run deploy.yml -f sha="<full git sha>"
gh run watch          # then approve the "production" environment when asked
```
The workflow (ci-engineer writes `.github/workflows/deploy.yml` to this spec) runs exactly the manual steps below, using the `shoestring-deployer` identity through OIDC. Workflow constraints (F-16): `permissions: {}` except `id-token: write` and `contents: read` on the deploy job; environment `production`; **no `pnpm install` or checkout of app code** in the deploy job; actions pinned by SHA. The workflow never runs admin commands (OD-3).

## Steps: manual path (same commands, if the workflow is unavailable)
```sh
export PROJECT="shoestring-prod-<suffix>" REGION="us-east1"
export SHA="<full git sha>"
export GH_REPO="<owner>/<repo>"
GH_REPO_LC=$(printf '%s' "$GH_REPO" | tr '[:upper:]' '[:lower:]')     # GHCR paths are lowercase (bash 3.2: no ${,,})
export GHCR_IMAGE="ghcr.io/$GH_REPO_LC:sha-$SHA"
export GHCR_MIGRATE_IMAGE="ghcr.io/$GH_REPO_LC-migrate:sha-$SHA"
export AR_REPO="$REGION-docker.pkg.dev/$PROJECT/shoestring/app"
export MIGRATE_AR_REPO="$REGION-docker.pkg.dev/$PROJECT/shoestring/migrate"

# 1. Copy both CI-built images (same SHA) to Artifact Registry. Same digests; never rebuild.
DIGEST=$(crane digest "$GHCR_IMAGE")
crane copy "$GHCR_IMAGE" "$AR_REPO:sha-$SHA"
IMAGE="$AR_REPO@$DIGEST"
MIGRATE_DIGEST=$(crane digest "$GHCR_MIGRATE_IMAGE")
crane copy "$GHCR_MIGRATE_IMAGE" "$MIGRATE_AR_REPO:sha-$SHA"
MIGRATE_IMAGE="$MIGRATE_AR_REPO@$MIGRATE_DIGEST"
echo "$IMAGE"; echo "$MIGRATE_IMAGE"

# 2. Record what is serving now (for rollback and the prod-previous tag)
PREV_REVISION=$(gcloud run services describe shoestring --region "$REGION" --project "$PROJECT" --format=json \
  | jq -r '.status.traffic[] | select(.percent==100) | .revisionName')
PREV_IMAGE=$(gcloud run revisions describe "$PREV_REVISION" --region "$REGION" --project "$PROJECT" \
  --format='value(spec.containers[0].image)')
echo "previous: $PREV_REVISION $PREV_IMAGE"

# 3. Migrations first (migrator role, expand-only), with the NEW release's MIGRATE image.
#    The image's entrypoint runs the migration: never add --command or --args. Its only config is the
#    MIGRATOR_DATABASE_URL secret pinned on the job. It has no Sentry: --wait exiting non-zero and the
#    job log are the only failure signals.
gcloud run jobs update shoestring-migrate --image "$MIGRATE_IMAGE" --region "$REGION" --project "$PROJECT"
gcloud run jobs execute shoestring-migrate --region "$REGION" --project "$PROJECT" --wait

# 4. New revision with NO traffic, reachable on a tag URL
gcloud run deploy shoestring --image "$IMAGE" --region "$REGION" --project "$PROJECT" \
  --no-traffic --tag candidate --update-env-vars "APP_RELEASE=$SHA"

# 5. Readiness gate on the candidate (wakes the DB, checks migrations)
CANDIDATE_URL=$(gcloud run services describe shoestring --region "$REGION" --project "$PROJECT" --format=json \
  | jq -r '.status.traffic[] | select(.tag=="candidate") | .url')
curl -fsS -m 10 "$CANDIDATE_URL/api/readyz"  && echo
curl -fsS -m 10 "$CANDIDATE_URL/api/healthz" && echo     # release field should equal $SHA (backend to confirm the field)
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$CANDIDATE_URL/api/_test/reset"   # must print 404: test hooks absent (F-10)

# 6. Shift all traffic, drop the tag, re-probe on the PUBLIC URL, and point the jobs at the new image
gcloud run services update-traffic shoestring --to-latest --region "$REGION" --project "$PROJECT"
gcloud run services update-traffic shoestring --remove-tags candidate --region "$REGION" --project "$PROJECT"
PUBLIC_URL=$(gcloud run services describe shoestring --region "$REGION" --project "$PROJECT" --format 'value(status.url)')
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$PUBLIC_URL/api/_test/reset"   # must print 404 (F-10); else roll back NOW
curl -fsS -m 10 "$PUBLIC_URL/api/readyz" && echo
gcloud run jobs update shoestring-purge --image "$IMAGE" --region "$REGION" --project "$PROJECT"
gcloud run jobs update shoestring-admin --image "$IMAGE" --region "$REGION" --project "$PROJECT"
gcloud run jobs update shoestring-rewrap-mfa --image "$IMAGE" --region "$REGION" --project "$PROJECT"
# shoestring-backup uses its own image and is updated by the owner only (bootstrap step 12g)

# 7. Protect the rollback target and the images the jobs use from the registry cleanup policy
gcloud artifacts docker tags add "$PREV_IMAGE" "$AR_REPO:prod-previous"
gcloud artifacts docker tags add "$IMAGE" "$AR_REPO:prod-current"
gcloud artifacts docker tags add "$MIGRATE_IMAGE" "$MIGRATE_AR_REPO:prod-current"   # the job's image; no prod-previous (rollback never migrates)
```
Steps 4 and 6 use `gcloud run deploy` flags until deploy/cloudrun/service.yaml exists. After that, step 4 becomes `gcloud run services replace deploy/cloudrun/service.yaml` with the image digest filled in, preceded by the same command with `--dry-run`.

## Verify
- `curl -fsS https://shoestring.<domain>/api/healthz` returns 200 with the new release.
- `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://shoestring.<domain>/api/_test/reset` prints **404** (F-10) on the custom domain too (step 6 probed the `run.app` URL). Anything else: roll back at once (rollback.md) and tell the tech lead (security incident).
- On your phone: open the app, sign in, add a transaction, see it in the month view (J2/J3).
- **Sentry smoke check** (below): it passes, and Sentry shows no new `production` issues within 15 minutes.
- Better Stack monitor is green.

### Sentry smoke check (read-only; sends no user data)
It proves the release is wired to Sentry without creating a fake error from user traffic. Run it from your Mac with `~/shoestring-prod.env` sourced (it provides `DOMAIN` and `SENTRY_DSN_WEB`) and `SHA` set.
```sh
SITE="https://shoestring.$DOMAIN"
WEB_HOST=$(printf '%s' "$SENTRY_DSN_WEB" | sed -E 's#^https://[^@]+@([^/]+)/.*#\1#')
# JS files referenced by the page and one level of imports (the Sentry SDK is a lazy chunk)
assets() { curl -fsS "$SITE/" | grep -Eo '/assets/[A-Za-z0-9_.-]+\.js' | sort -u | while read -r a; do
  echo "$a"; curl -fsS "$SITE$a" | grep -Eo 'assets/[A-Za-z0-9_.-]+\.js' | sed 's#^#/#'; done | sort -u; }
assets | while read -r a; do curl -fsS "$SITE$a"; echo; done | grep -c "$WEB_HOST"   # 1. >= 1: the SPA build has the web DSN
assets | while read -r a; do curl -fsS "$SITE$a"; echo; done | grep -c "$SHA"        # 2. >= 1: the SPA reports this release
assets | while read -r a; do printf '%s ' "$(curl -s -o /dev/null -w '%{http_code}' "$SITE$a.map")"; done; echo   # 3. all 404: maps are not public
curl -sSI "$SITE/" | grep -i '^content-security-policy' | grep -c "connect-src 'self' https://$WEB_HOST"   # 4. 1: CSP allows exactly that host
curl -sSI "$SITE/" | grep -i '^reporting-endpoints'                                                   # 5. csp="https://<same host>/api/<api project id>/security/?sentry_key=…"
```
6. In Sentry: **Releases** lists `$SHA`. `shoestring-web` → Settings → **Source Maps → Artifact Bundles** shows a bundle uploaded for this build (ci-engineer's private upload). A missing bundle means unreadable stack traces, not a broken site. Tell the tech lead, but don't roll back for it.
7. **Backend path**, without a test error:
   - Monitors → Crons → `purge` shows the last check-in as OK, with the release it ran. The next scheduled run (08:00 UTC) uses this release's image.
   - For an immediate check, `gcloud scheduler jobs run shoestring-purge-daily --project "$PROJECT" --location "$REGION"`. Purge is idempotent, so this is safe outside 08:00–09:30 UTC.
   - Then the newest check-in turns green within 2 minutes.
8. **[needs backend: admin command `sentry-test`]** This sends one fixed-text `info` event from the production image, with the release and environment and **no user data**:
   ```sh
   gcloud run jobs execute shoestring-admin --args sentry-test --region "$REGION" --project "$PROJECT" --wait
   ```
   - The event appears in `shoestring-api` (environment `production`, release `$SHA`).
   - Run docs/runbooks/sentry-data-check.md step 1 on it: `user` has no IP, and there is no request data.
   - The **first** run ever also sends an `error-new` email, which proves the alert path. Later runs reuse the same issue and stay quiet. Leave that issue unresolved.

**If 1, 2 or 4 fails:** the release reports nothing, or the browser blocks the reports. That isn't user-facing, so there is **no rollback**. Tell the tech lead (ci-engineer for 1–2, backend-engineer for 4–5).
**If 3 fails** (a `.map` returns 200): source code is public. Roll back (rollback.md) and tell the tech lead.
**After any change** to the Sentry SDK setup or the Sentry settings, also run the canary (sentry-data-check.md step 2).
- Record the deploy (date, SHA, revision) in the release notes or PR.

## Back out
- **Before step 6** (gate failed): nothing serves the new revision. Run `gcloud run services update-traffic shoestring --remove-tags candidate --region "$REGION" --project "$PROJECT"`. The expand-only migration can stay.
- **After step 6:** follow rollback.md (one command: traffic back to `$PREV_REVISION`).
- **The candidate's `/api/_test/reset` is not 404:** stop and do not shift traffic. Drop the tag as above and tell the tech lead (F-10).
- **Step 6's public `/api/_test/reset` probe is not 404:** roll back at once (rollback.md step 2), then tell the tech lead (security incident, F-10).
- **Migration job failed:** nothing was deployed (the job runs no Sentry, so this is the only place it shows). Read the job logs (`gcloud run jobs executions list --job shoestring-migrate --region "$REGION" --project "$PROJECT"`, then Logging), and hand them to the tech lead for data-engineer. Do not re-run blindly.
