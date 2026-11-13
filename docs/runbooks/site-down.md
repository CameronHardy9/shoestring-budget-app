# Alert A1: site down
- Owner: sre · Runs: **owner** · Status: **DRAFT, pending first deploy** · Source: Better Stack monitor `shoestring-healthz` (observability/README.md)

## When to use
Better Stack reports `https://shoestring.<domain>/api/healthz` failing from 2 regions for 2 checks in a row.

## Steps
```sh
export PROJECT="shoestring-prod-<suffix>" REGION="us-east1" DOMAIN="<domain>"
# 1. Is it the domain or the service?
curl -sS -m 10 -o /dev/null -w 'custom domain: %{http_code}\n' "https://shoestring.$DOMAIN/api/healthz"
URL=$(gcloud run services describe shoestring --region "$REGION" --project "$PROJECT" --format 'value(status.url)')
curl -sS -m 10 -o /dev/null -w 'run.app: %{http_code}\n' "$URL/api/healthz"
```
| run.app | custom domain | Likely cause | Go to |
|---|---|---|---|
| 200 | fails | DNS, certificate or domain mapping | step 2 |
| fails | fails | Service, billing pause or Google outage | step 3 |

2. **Domain path:**
   - `gcloud beta run domain-mappings describe --domain "shoestring.$DOMAIN" --region "$REGION" --project "$PROJECT" --format "yaml(status.conditions)"`. All conditions should be True.
   - In Cloudflare → DNS, the `shoestring` CNAME must point to `ghs.googlehosted.com` and be **DNS only**.
   - `dig +short "shoestring.$DOMAIN"`.
   - If the mapping was withdrawn or its certificate failed to renew: tell the tech lead. The Cloudflare proxy fallback (hosting-evaluation.md §3a) is switched on **only after a security-reviewer review and sign-off** (owner ruling 2026-11-13); the tech lead requests it.
3. **Service path:**
   - Billing: `gcloud billing projects describe "$PROJECT" --format 'value(billingEnabled)'`, and Billing → Budgets for spend-cap status. If paused, go to billing-alert.md.
   - Recent deploy: `gcloud run revisions list --service shoestring --region "$REGION" --project "$PROJECT" --limit 3`. If one is new, follow **rollback.md**.
   - Errors: `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="shoestring" AND severity>=ERROR' --project "$PROJECT" --freshness 30m --limit 50 --format 'value(timestamp,jsonPayload.message,textPayload)'`
   - Google Cloud status page (status.cloud.google.com), Cloud Run in us-east1.
4. Collect the evidence (times, revision, error lines, which path failed) for the tech lead.

## Verify
Better Stack shows the monitor green again, and on your phone the app opens and shows the month.

## Back out
Undo whatever mitigation you applied: roll forward (rollback.md "Back out"), or turn the DNS record back to its previous state. Write a postmortem in incidents/ if users were affected.
