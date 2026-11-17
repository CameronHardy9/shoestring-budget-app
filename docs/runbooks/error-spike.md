# Alert A2: error spike
- Owner: sre · Runs: **owner** · Status: **DRAFT, pending first deploy**
- Source: Sentry alert rules `error-new` and `error-spike`, both projects (`shoestring-api`, `shoestring-web`), environment `production`. Set up in bootstrap-production.md step 13C; definitions in observability/README.md.
- Delivery: email to you; your phone notifies through the Gmail label `Shoestring alerts` (step 13A).

## When to use
An email from Sentry says one of these happened in `production`:
- **`error-new`:** a new error issue appeared, a resolved one came back (regression), or Sentry marked one as escalating.
- **`error-spike`:** one issue received more than 10 events within 15 minutes.

## Steps
1. **Open the issue** from the email (it opens sentry.io; sign in with your key). Note:
   - the **release** (git SHA), the **route** tag and the error type
   - first seen and last seen
   - one **requestId** tag
2. **Check for sensitive data (one minute).** Do docs/runbooks/sentry-data-check.md step 1 on the latest event. Events should never contain emails, names, amounts, payees, memos, IPs, tokens, query strings or fragments. If you find any, finish this runbook's mitigation, then follow sentry-data-check.md step 3 and tell the tech lead (security incident).
3. **Follow the request in the logs:**
   ```sh
   export PROJECT="shoestring-prod-<suffix>" REGION="us-east1"
   gcloud logging read 'jsonPayload.requestId="<requestId>"' --project "$PROJECT" --freshness 1d --format json | jq '.[].jsonPayload'
   ```
4. **Decide:**
   | Signal | Likely cause | Action |
   |---|---|---|
   | First seen right after a deploy; release = the new SHA | Bad release | **rollback.md** now, debug after |
   | `UNAVAILABLE` / 503 from `/api/readyz`, DB timeouts | Neon down, suspended (CU-hours used up) or storage full | Neon Console → Usage and status page. If CU-hours are exhausted, the database stays suspended until the 1st; tell the tech lead (R3). |
   | Many `RATE_LIMITED` / 429s, request count far above normal | Flood (R1) | Cloud Run metrics; billing-alert.md; ask the tech lead about the Cloudflare fallback (hosting-evaluation.md §3a), which is switched on **only after a security-reviewer review and sign-off** (owner ruling 2026-11-13) |
   | Errors only in `shoestring-web` (one browser or version) | Frontend bug | Tech lead → debugger |
   | `CSRF_FAILED` / auth errors for everyone | Config or secret change | Check recent `gcloud run services describe` changes; rotate-secret.md "Back out" |
   | Issue from the `purge` monitor, or titled `email_quota_threshold: …` | Not an A2 problem | purge-failed.md or email-quota.md |
5. **Protect the Sentry quota** if the issue is still receiving events quickly. The free plan accepts **5,000 errors a month** and then drops everything until the 1st, which leaves you blind. Per-key rate limits are a paid feature.
   - Org Settings → **Stats → Usage**: check how much of the month is used.
   - Spike Protection (step 11b, S4) drops a sudden burst by itself. A steady flood becomes its new baseline.
   - The fix that stops the events is the rollback (step 4). **Archive** the issue only after the cause is fixed.
6. **Hand over** the evidence to the tech lead for the debugger: Sentry issue links, requestIds, the release, times and the action taken. Send links only, never pasted event contents.

## Verify
- The issue stops receiving new events (Sentry → issue → events chart) for 30 minutes. Then **Resolve** it with a note, for example "fixed by rollback to <sha>".
- Stats → Usage shows the error count has stopped climbing.

## Back out
Undo the mitigation (rollback.md "Back out"). Write a postmortem in incidents/ if users were affected.
