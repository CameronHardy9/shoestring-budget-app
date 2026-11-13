# Deploy a release
- Owner: sre · Runs: **owner** (approves the GitHub `production` environment, or runs the manual commands) · Status: **DRAFT, pending first deploy**
- Platform: Cloud Run `shoestring` in us-east1 (infra/CLAUDE.md). The first-ever deploy is in bootstrap-production.md (planned), because `--no-traffic` needs an existing service.

## When to use
To release a commit on `main` whose CI run is green. One release at a time. Avoid 08:00–09:30 UTC (purge and backup run then).

## Preconditions
- CI is green for the commit, and the image `ghcr.io/<owner>/<repo>:sha-<full sha>` exists (ci-engineer confirms the exact name).
- Any migration in the release is **expand-only**: the currently serving version must keep working against the new schema (data-engineer's checklist). Otherwise stop; rollback would not be safe.
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
export GHCR_IMAGE="ghcr.io/<owner>/<repo>:sha-$SHA"
export AR_REPO="$REGION-docker.pkg.dev/$PROJECT/shoestring/app"

# 1. Copy the CI-built image to Artifact Registry. Same digest; never rebuild.
DIGEST=$(crane digest "$GHCR_IMAGE")
crane copy "$GHCR_IMAGE" "$AR_REPO:sha-$SHA"
IMAGE="$AR_REPO@$DIGEST"
echo "$IMAGE"

# 2. Record what is serving now (for rollback and the prod-previous tag)
PREV_REVISION=$(gcloud run services describe shoestring --region "$REGION" --project "$PROJECT" --format=json \
  | jq -r '.status.traffic[] | select(.percent==100) | .revisionName')
PREV_IMAGE=$(gcloud run revisions describe "$PREV_REVISION" --region "$REGION" --project "$PROJECT" \
  --format='value(spec.containers[0].image)')
echo "previous: $PREV_REVISION $PREV_IMAGE"

# 3. Migrations first (migrator role, expand-only), with the NEW image
gcloud run jobs update shoestring-migrate --image "$IMAGE" --region "$REGION" --project "$PROJECT"
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

# 6. Shift all traffic, drop the tag, and point the jobs at the new image
gcloud run services update-traffic shoestring --to-latest --region "$REGION" --project "$PROJECT"
gcloud run services update-traffic shoestring --remove-tags candidate --region "$REGION" --project "$PROJECT"
gcloud run jobs update shoestring-purge --image "$IMAGE" --region "$REGION" --project "$PROJECT"
gcloud run jobs update shoestring-admin --image "$IMAGE" --region "$REGION" --project "$PROJECT"
gcloud run jobs update shoestring-rewrap-mfa --image "$IMAGE" --region "$REGION" --project "$PROJECT"
# shoestring-backup uses its own image and is updated by the owner only (bootstrap step 12g)

# 7. Protect the rollback target from the registry cleanup policy
gcloud artifacts docker tags add "$PREV_IMAGE" "$AR_REPO:prod-previous"
gcloud artifacts docker tags add "$IMAGE" "$AR_REPO:prod-current"
```
Steps 4 and 6 use `gcloud run deploy` flags until deploy/cloudrun/service.yaml exists. After that, step 4 becomes `gcloud run services replace deploy/cloudrun/service.yaml` with the image digest filled in, preceded by the same command with `--dry-run`.

## Verify
- `curl -fsS https://shoestring.<domain>/api/healthz` returns 200 with the new release.
- `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://shoestring.<domain>/api/_test/reset` prints **404** (F-10). Anything else: roll back at once and tell the tech lead (security incident).
- On your phone: open the app, sign in, add a transaction, see it in the month view (J2/J3).
- Sentry → Releases shows `$SHA`; no new issues within 15 minutes.
- Better Stack monitor is green.
- Record the deploy (date, SHA, revision) in the release notes or PR.

## Back out
- **Before step 6** (gate failed): nothing serves the new revision. Run `gcloud run services update-traffic shoestring --remove-tags candidate --region "$REGION" --project "$PROJECT"`. The expand-only migration can stay.
- **After step 6:** follow rollback.md (one command: traffic back to `$PREV_REVISION`).
- **The candidate's `/api/_test/reset` is not 404:** stop and do not shift traffic. Drop the tag as above and tell the tech lead (F-10).
- **Migration job failed:** nothing was deployed. Read the job logs (`gcloud run jobs executions list --job shoestring-migrate --region "$REGION" --project "$PROJECT"`, then Logging), and hand them to the tech lead for data-engineer. Do not re-run blindly.
