# Alert A3: purge failed or missed
- Owner: sre · Runs: **owner** · Status: **DRAFT, pending first deploy and the backend's Sentry cron check-in**
- Source: Sentry cron monitor **`purge`** (project `shoestring-api`; crontab `0 8 * * *` UTC; check-in margin 60 min; max runtime 15 min; failure tolerance 1), with the alert rule `purge-cron` (bootstrap-production.md steps 13B and 13C).
- Delivery: email; phone notification through the Gmail label `Shoestring alerts`.

## When to use
Sentry emails that monitor `purge` has a **missed** or **failed** check-in. The monitor's issue says which one:
| Sentry says | Meaning |
|---|---|
| **Missed check-in** | No "in progress" check-in arrived by **09:00 UTC** (08:00 + 60 min margin). The job didn't start, or it started without reaching Sentry. |
| **Timeout** (also shown as missed or failed) | The job checked in as "in progress" but sent no final check-in within **15 minutes**: it hung or was killed. |
| **Failed check-in** | The job finished with an error. The backend reports exit code ≠ 0 as `error`. |

Purge enforces the deletion promise (30-day grace, data gone from backups within 35 more days). **One missed day is not urgent; several are.**

## Steps
```sh
export PROJECT="shoestring-prod-<suffix>" REGION="us-east1"
gcloud scheduler jobs describe shoestring-purge-daily --location "$REGION" --project "$PROJECT" --format 'yaml(state,lastAttemptTime,status)'
gcloud run jobs executions list --job shoestring-purge --region "$REGION" --project "$PROJECT" --limit 5
EXEC=$(gcloud run jobs executions list --job shoestring-purge --region "$REGION" --project "$PROJECT" --limit 1 --format 'value(metadata.name)')
gcloud logging read "resource.type=\"cloud_run_job\" AND labels.\"run.googleapis.com/execution_name\"=\"$EXEC\"" \
  --project "$PROJECT" --limit 50 --order asc --format 'value(jsonPayload.message,textPayload)'    # counts only, by design
gcloud run jobs describe shoestring-purge --region "$REGION" --project "$PROJECT" --format json \
  | jq -r '.spec.template.spec.template.spec.containers[0].env[] | select(.name=="SENTRY_DSN") | (.value | sub("^https://[^@]+@"; "https://…@"))'   # DSN present (key hidden)
```
| Finding | Likely cause | Action |
|---|---|---|
| No execution at 08:00 | Scheduler paused or its permission is broken | `gcloud scheduler jobs resume shoestring-purge-daily ...`; check the invoker binding (bootstrap step 12e) |
| No execution, and billing-alert.md fired | The spend cap paused the project | billing-alert.md (it re-runs purge and backup afterwards) |
| Execution failed to start, image not found | Image deleted from Artifact Registry | The job must point at the `prod-current` digest: `gcloud run jobs update shoestring-purge --image <prod-current digest>` |
| Execution **succeeded**, but Sentry says missed | The check-in never reached Sentry: `SENTRY_DSN` missing or wrong on the job, or the monitor slug isn't exactly `purge` | Compare the DSN above with `shoestring-api` → Client Keys; Monitors → Crons must list **only** `purge`. A second, auto-created monitor means a slug mismatch: tell the tech lead (backend) and delete the extra monitor. |
| Execution ran past 15 min, or was killed at the 10-min task timeout | Hang, or a slow DB | Logs above; Neon status. Tech lead → debugger |
| DB connection errors | Neon down or suspended | See error-spike.md, Neon row |
| Exit code 1 with a skipped-user log line | F-25 safety re-check: a user due for deletion now shares a budget. The command skips them and exits 1 **on purpose** so this alert fires. | Expected safety behaviour. Tell the tech lead; they decide with the user. |
| Exit code 1 | Bug | Tech lead → debugger, with the execution name and time |
| Monitor shows **Muted** | Sentry auto-mutes a monitor that has been broken for a long time | Fix the cause, then unmute it in the monitor's header |

Also do docs/runbooks/sentry-data-check.md step 1 on the monitor's latest event. Purge events must carry counts only, never emails or IDs of deleted users.

When the cause is fixed, re-run the job. Purge is idempotent, so a re-run is safe:
```sh
gcloud run jobs execute shoestring-purge --region "$REGION" --project "$PROJECT" --wait
```

## Verify
- The execution succeeds, and its log shows counts per step.
- Monitors → Crons → `purge` shows a green check-in within 2 minutes.
- The monitor's issue resolves by itself after 1 successful check-in (recovery tolerance 1). If it doesn't, resolve it by hand.

## Back out
Nothing to back out. Purge only deletes what is already past its deadline. If you paused the monitor while debugging (monitor header → **Pause**), unpause it. A paused monitor never alerts.
