# Roll back to the previous release
- Owner: sre · Runs: **owner** · Status: **DRAFT, pending first deploy** (must be rehearsed once right after the second deploy)

## When to use
A release is live and users are affected (error spike, broken journey, failed smoke test), and the cause is in the new code or config, not in data. If data is wrong, see restore.md. Roll back first, debug after.

## Preconditions
- The previous revision's image is still in Artifact Registry (the `prod-previous` tag protects it from cleanup).
- Migrations are expand/contract, so the previous code works against the current schema. **We never run down-migrations.**
- The previous release's `/api/readyz` still passes: it checks only that the newest migration **its own build** ships with has been applied (db `isSchemaCurrent`), and a newer schema contains it.

**The migrate job is not part of a rollback.** Don't execute `shoestring-migrate` and don't point it at an older migrate image:
- The schema the bad release added is expand-only and stays. Running the older migrate image would only re-check what is already applied, and it has nothing to undo.
- The job keeps the bad release's migrate image and its `migrate:prod-current` tag, which is correct: that is what the job references, and the next deploy (deploy.md step 3) replaces both with the fix's migrate image.
- If the bad release's **migration itself** is the problem (wrong data or a lock), a rollback doesn't help: involve the tech lead (data-engineer). A forward fix ships as a new migration in a new release.

## Steps
```sh
export PROJECT="shoestring-prod-<suffix>" REGION="us-east1"
export AR_REPO="$REGION-docker.pkg.dev/$PROJECT/shoestring/app"

# 1. Find the previous good revision (newest first; the one serving now is at the top)
gcloud run revisions list --service shoestring --region "$REGION" --project "$PROJECT" --limit 5 \
  --format="table(metadata.name,metadata.creationTimestamp,spec.containers[0].image)"
export PREV_REVISION="<name of the revision before the bad one>"

# 2. THE ROLLBACK: one command, takes effect in seconds
gcloud run services update-traffic shoestring --to-revisions "$PREV_REVISION=100" \
  --region "$REGION" --project "$PROJECT"

# 3. Point the app-image jobs back at the previous image too (not shoestring-migrate: see above)
PREV_IMAGE=$(gcloud run revisions describe "$PREV_REVISION" --region "$REGION" --project "$PROJECT" \
  --format='value(spec.containers[0].image)')
gcloud run jobs update shoestring-purge --image "$PREV_IMAGE" --region "$REGION" --project "$PROJECT"
gcloud run jobs update shoestring-admin --image "$PREV_IMAGE" --region "$REGION" --project "$PROJECT"
gcloud run jobs update shoestring-rewrap-mfa --image "$PREV_IMAGE" --region "$REGION" --project "$PROJECT"

# 4. Keep the registry tags truthful (app package only; migrate:prod-current stays on the job's image)
gcloud artifacts docker tags add "$PREV_IMAGE" "$AR_REPO:prod-current"
```
5. Check the rolled-back release on the public URL, as deploy.md step 6 does: `curl -s -o /dev/null -w '%{http_code}\n' -X POST "$(gcloud run services describe shoestring --region "$REGION" --project "$PROJECT" --format 'value(status.url)')/api/_test/reset"` prints **404** (F-10).
Traffic is now pinned to `$PREV_REVISION`. The next normal deploy's `--to-latest` un-pins it.

## Verify
- `curl -fsS https://shoestring.<domain>/api/healthz` shows the previous release.
- `gcloud run services describe shoestring --region "$REGION" --project "$PROJECT" --format="yaml(status.traffic)"` shows 100% on `$PREV_REVISION`.
- Sentry error rate drops back; the journey that broke works on your phone.
- Tell the tech lead: bad SHA, time of rollback, symptoms, Sentry issue links. A postmortem goes in incidents/ if users were affected.

## Back out (roll forward again)
```sh
gcloud run services update-traffic shoestring --to-latest --region "$REGION" --project "$PROJECT"
```
Then restore the job images and `prod-current` tag as in deploy.md steps 6 and 7.

## Known limits
- Only `prod-current`, `prod-previous` and the 3 newest app images are guaranteed to exist. To go back further, copy the older app image from GHCR again (deploy.md step 1, app image only) and deploy it normally (skip deploy.md step 3: the schema is already newer).
- A rollback does not undo data written by the bad release. If the bad release wrote wrong data, involve the tech lead (debugger + data-engineer) before restoring anything.
