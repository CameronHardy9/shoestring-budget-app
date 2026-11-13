# Alert A5: billing threshold or spend cap reached
- Owner: sre · Runs: **owner** · Status: **DRAFT** · Source: GCP budgets `shoestring-prod-1usd`, `shoestring-backup-1usd` (billing-protection.md §1, §2A)

## When to use
Any budget email: actual spend ≥ $0.01, $0.50 or $1.00, a $1.00 forecast, or a spend-cap notice. The target is $0.00, so **any** alert means something is off.

## Steps
1. Console → **Billing → Reports**: the current month, filtered to the project named in the email, grouped by **SKU**. Find the SKU with a non-zero net cost.
2. Match it and act:
   | SKU family | Likely cause | Action |
   |---|---|---|
   | Cloud Run requests / CPU | Flood (R1), or a loop calling the API | Cloud Run → Metrics (requests, instances). Lower to `--max-instances 1` if needed: `gcloud run services update shoestring --max-instances 1 --region us-east1 --project "$PROJECT"`. Ask the tech lead about the Cloudflare fallback (hosting-evaluation.md §3a), switched on **only after a security-reviewer review and sign-off** (owner ruling 2026-11-13). |
   | Artifact Registry storage | Cleanup policy off or in dry-run; too many images | billing-protection.md §5 |
   | Cloud Logging | Exclusions missing, or `LOG_LEVEL=debug` | billing-protection.md §6; set `LOG_LEVEL=info` |
   | Secret Manager | More than 6 active versions | billing-protection.md §8; destroy superseded versions |
   | Cloud Storage | Soft delete on, wrong region, lifecycle missing | billing-protection.md §7 |
   | Container Scanning, Cloud Build, Compute | API enabled by mistake | billing-protection.md §4; disable it |
3. **If the spend cap has paused services**, Cloud Run is paused project-wide:
   - The **site is down**.
   - The **daily purge stops**: deletions due during the pause are delayed.
   - The **nightly backup stops** too: alert A4 fires. Letting the cap pause backups was sre's recommendation, **confirmed by the owner (2026-11-13)**.
   - The backup project is not capped, so existing backups stay readable for a restore.

   Choose one:
   - (a) Wait for the next billing period (keeps $0; the app is down until then).
   - (b) Fix the cause, then lift or raise the cap. This **spends money** and is your decision alone.
   Tell beta users either way.
4. **After the cap lifts** (new period or raised cap), run both jobs by hand at once, then check alerts A3 and A4 clear:
   ```sh
   gcloud run jobs execute shoestring-purge --region us-east1 --project "$PROJECT" --wait
   gcloud run jobs execute shoestring-backup --region us-east1 --project "$PROJECT" --wait
   ```
   **Privacy-notice input (security-reviewer):** account and data deletions can be delayed by outages, including a paused billing cap. They run at the next successful purge.
5. Record what happened in incidents/, and update infra/cost-sheet.md if a limit or assumption was wrong.

## Verify
The next day's report shows the SKU's daily cost back at $0.00. After the month closes, billing-protection.md §11 check 1 shows $0.00 net (or the known overshoot).

## Back out
Undo temporary limits (for example, set `--max-instances 2` again) once the cause is gone.
