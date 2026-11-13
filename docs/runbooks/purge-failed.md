# Alert A3: purge failed or missed
- Owner: sre · Runs: **owner** · Status: **DRAFT, pending first deploy and the backend's Sentry cron check-in** · Source: Sentry cron monitor `purge`

## When to use
Sentry reports the daily `purge` check-in as missed or failed. Purge enforces the deletion promise (30-day grace, data gone from backups within 35 more days), so one missed day is not urgent. Several missed days are.

## Steps
```sh
export PROJECT="shoestring-prod-<suffix>" REGION="us-east1"
gcloud scheduler jobs describe shoestring-purge-daily --location "$REGION" --project "$PROJECT" --format 'yaml(state,lastAttemptTime,status)'
gcloud run jobs executions list --job shoestring-purge --region "$REGION" --project "$PROJECT" --limit 5
EXEC=$(gcloud run jobs executions list --job shoestring-purge --region "$REGION" --project "$PROJECT" --limit 1 --format 'value(metadata.name)')
gcloud logging read "resource.type=\"cloud_run_job\" AND labels.\"run.googleapis.com/execution_name\"=\"$EXEC\"" \
  --project "$PROJECT" --limit 50 --order asc --format 'value(jsonPayload.message,textPayload)'    # counts only, by design
```
| Finding | Likely cause | Action |
|---|---|---|
| No execution at 08:00 | Scheduler paused or its permission is broken | `gcloud scheduler jobs resume shoestring-purge-daily ...`; check the invoker binding (bootstrap step 12e) |
| Execution failed to start, image not found | Image deleted from Artifact Registry | The job must point at the `prod-current` digest: `gcloud run jobs update shoestring-purge --image <prod-current digest>` |
| DB connection errors | Neon down or suspended | See error-spike.md, Neon row |
| Exit code 1 with a skipped-user log line | F-25 safety re-check: a user due for deletion now shares a budget. The command skips them and exits 1 **on purpose** so this alert fires. | Expected safety behaviour. Tell the tech lead; they decide with the user. |
| Exit code 1 | Bug | Tech lead → debugger, with the execution name and time |

When the cause is fixed, re-run it. Purge is idempotent, so a re-run is safe:
```sh
gcloud run jobs execute shoestring-purge --region "$REGION" --project "$PROJECT" --wait
```

## Verify
The execution succeeds, its log shows counts per step, and the Sentry monitor returns to OK on the next check-in.

## Back out
Nothing to back out. Purge only deletes what is already past its deadline.
