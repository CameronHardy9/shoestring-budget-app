# Alert A2: error spike
- Owner: sre · Runs: **owner** · Status: **DRAFT, pending first deploy** · Source: Sentry issue alert `error-spike` (observability/README.md)

## When to use
Sentry reports an issue seen more than 10 times in 10 minutes, or a new issue, in `production`.

## Steps
1. Open the issue from the push or email. Note the **release**, route, error code, first-seen time and one **requestId**. Events contain no financial data or emails by design. If you ever see such data, treat it as a security issue and tell the tech lead.
2. Follow that request in the logs:
   ```sh
   export PROJECT="shoestring-prod-<suffix>" REGION="us-east1"
   gcloud logging read 'jsonPayload.requestId="<requestId>"' --project "$PROJECT" --freshness 1d --format json | jq '.[].jsonPayload'
   ```
3. Decide:
   | Signal | Likely cause | Action |
   |---|---|---|
   | First seen right after a deploy; release = the new SHA | Bad release | **rollback.md** now, debug after |
   | `UNAVAILABLE` / 503 from `/api/readyz`, DB timeouts | Neon down, suspended (CU-hours used up) or storage full | Neon Console → Usage and status page. If CU-hours are exhausted, the database stays suspended until the 1st; tell the tech lead (R3). |
   | Many `RATE_LIMITED` / 429s, request count far above normal | Flood (R1) | Cloud Run metrics; billing-alert.md; ask the tech lead about the Cloudflare fallback (hosting-evaluation.md §3a), which is switched on **only after a security-reviewer review and sign-off** (owner ruling 2026-11-13) |
   | Errors only in `shoestring-web` (one browser or version) | Frontend bug | Tech lead → debugger |
   | `CSRF_FAILED` / auth errors for everyone | Config or secret change | Check recent `gcloud run services describe` changes; rotate-secret.md "Back out" |
4. Hand the evidence to the tech lead for the debugger: Sentry links, requestIds, release, times and the action taken.

## Verify
The issue stops receiving new events (Sentry → issue → events chart) for 30 minutes. Resolve it in Sentry with a note.

## Back out
Undo the mitigation (rollback.md "Back out"). Write a postmortem in incidents/ if users were affected.
