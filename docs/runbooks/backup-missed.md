# Alert A4: backup missed or failed
- Owner: sre · Runs: **owner** · Status: **DRAFT, pending the backup image and job** · Source: Better Stack heartbeat `shoestring-backup`
- Design: README.md "Backup design". The Cloud Run job `shoestring-backup` is triggered by Cloud Scheduler `shoestring-backup-nightly` at 09:15 UTC and runs deploy/backup/backup.sh.

## When to use
No heartbeat for 26 hours, or the job pinged `/fail`. **Each missed night uses up the 24-hour RPO.** Fix it the same day.

## Steps
```sh
export PROJECT="shoestring-prod-<suffix>" REGION="us-east1" BACKUP_BUCKET="shoestring-backups-<suffix>"
gcloud scheduler jobs describe shoestring-backup-nightly --location "$REGION" --project "$PROJECT" \
  --format 'yaml(state,lastAttemptTime,status)'
gcloud run jobs executions list --job shoestring-backup --region "$REGION" --project "$PROJECT" --limit 5
EXEC=$(gcloud run jobs executions list --job shoestring-backup --region "$REGION" --project "$PROJECT" --limit 1 --format 'value(metadata.name)')
gcloud logging read "resource.type=\"cloud_run_job\" AND labels.\"run.googleapis.com/execution_name\"=\"$EXEC\"" \
  --project "$PROJECT" --limit 50 --order asc --format 'value(jsonPayload.message,textPayload)'
gcloud storage ls -l "gs://$BACKUP_BUCKET/daily/" | sort -k2 | tail -3
```
| Finding | Likely cause | Action |
|---|---|---|
| Scheduler `PAUSED`, or no execution at 09:15 | Scheduler paused, or its invoker permission is gone (V25) | `gcloud scheduler jobs resume shoestring-backup-nightly --location "$REGION" --project "$PROJECT"`; re-check bootstrap step 12g's binding |
| No executions at all, and the site is down too | The spend cap paused Cloud Run | billing-alert.md |
| Execution failed to start: image not found | The `prod-backup` image was deleted | Re-tag or re-copy the backup image (bootstrap step 12g) and `gcloud run jobs update shoestring-backup --image <digest>` |
| Log: `backup failed at line …` after a `pg_dump` error | Neon down or suspended, the `backup` password rotated without updating the secret, or the client is older than the server major | Neon status; rotate-secret.md (`shoestring-backup-database-url`); the backup image needs `postgresql17-client` or newer |
| Log: `encrypted dump smaller than … bytes` | Empty dump (wrong database in the URL, or the role lacks SELECT) | Check the URL's database name; data-engineer's roles script |
| Log: `could not obtain an access token`, or upload 403 | Job SA changed, or the bucket binding removed | `gcloud storage buckets get-iam-policy "gs://$BACKUP_BUCKET"` must show `objectCreator` for `shoestring-backup@`. **Never** grant read or delete. |
| Upload 412 | An object with the same name already exists (a retry after a successful upload) | Harmless if an object for that night exists |
| Job succeeded but no heartbeat | Heartbeat URL regenerated | rotate-secret.md "Backup heartbeat URL" |
Logs contain only the object name and byte count. Never paste anything else from a backup into issues or chat.

Re-run once the cause is fixed:
```sh
gcloud run jobs execute shoestring-backup --region "$REGION" --project "$PROJECT" --wait
```

## Verify
A new object `daily/shoestring-<today>.dump.age` with a plausible size (similar to the previous nights), and the heartbeat is green. If two or more nights were missed, tell the tech lead: the RPO was breached for that window.

## Back out
Nothing to back out. Revert any configuration change you made if it didn't help.
