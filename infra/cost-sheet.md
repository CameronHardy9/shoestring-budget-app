# Cost sheet: Shoestring production
- Owner: sre · Target: **$0.00 / month** (hard) · Last updated: 2026-11-12 · Status: **estimate before first deploy; platform accepted 2026-11-12** (spend cap at $1 is the hard cap)
- Load assumptions: infra/hosting-evaluation.md §1 (< 10 users, ~30,000 requests/month, planned for 100,000).
- Limits come from the tech lead's research (2026-11-12) and sre's background knowledge. Anything tagged (Vn) is unconfirmed; see the verify list in infra/hosting-evaluation.md.
- Re-check monthly with docs/runbooks/billing-protection.md §11. Update the "Actual" column after the first full month.

## Google Cloud: app project (card on file, capped)
Free tiers are per **billing account** (V1).
| Service / meter | Free limit | Expected use | Headroom | When the limit is hit | Warning signal |
|---|---|---|---|---|---|
| Cloud Run requests | 2,000,000 / month (V1) | ~30,000 (plan 100,000) | ~95% | Billed at ~$0.40/M (V2); spend cap pauses or kill switch detaches billing | Cloud Run metrics > 1 M/month; budget alert |
| Cloud Run vCPU-seconds (request-based) | 180,000 / month (V1) | ~10,000 (requests billed in 100 ms steps, cold starts with CPU boost) | ~94% | Billed at ~$0.000024/vCPU-s (V2) | Metrics: billable instance time > 120,000 s |
| Cloud Run GiB-seconds | 360,000 / month (V1) | ~5,000 (512 MiB) | ~98% | Billed at ~$0.0000025/GiB-s (V2) | Same |
| Cloud Run Jobs (migrate, purge, admin, rewrap-mfa, backup) | Instance-based allowance (V1) | ~2,500 vCPU-s (30 purges × ~15 s, 30 backups × ~60 s, ~10 migrations, a few admin runs) | > 98% | Billed | Job execution durations > 5 min |
| Cloud Run egress, North America | ~1 GiB / month (V1) | < 100 MB (SPA cached by the service worker; small JSON) | ~90% | ~$0.12/GB | Metrics: sent bytes > 700 MB |
| Artifact Registry storage | 0.5 GB-month (V4) | ~220–320 MB (app: `prod-current` + `prod-previous` + up to 3 recent, shared base layers; backup image ~20 MB tagged `prod-backup`) | ~35% | $0.10/GB-month | `sizeBytes` > 350 MB |
| Artifact Registry egress to Cloud Run (same region) | Free | — | — | — | Never pull cross-region |
| Secret Manager active versions | 6 (V6) | **5** (database-url, migrator-database-url, app-keyring, email-api-key, backup-database-url) | **1**: a rotation's extra version stays free | $0.06 / version / month, prorated (verify) | Count > 5 at the monthly check (billing-protection §8). The Cloudflare fallback's origin-auth secret would use the last free slot. |
| Secret Manager access operations | 10,000 / month (V6) | ~3,900 (≈ 40 instance starts/day × 3 secrets, plus purge 30 × 1 and backup 30 × 1, plus admin, rewrap and migrate runs) | ~50% | $0.03 / 10,000 | Cold starts > 70/day |
| Cloud Logging ingestion | 50 GiB / project / month | ~50 MB (one JSON line per request; platform request logs excluded) | > 99% | $0.50/GiB | Log storage page > 10 GiB |
| Cloud Logging retention | 30 days (`_Default`) | 30 days | 0 (do not raise) | Charged per GiB-month beyond 30 days | Retention ≠ 30 |
| Cloud Scheduler | 3 jobs / billing account | **2** (`purge`, `backup`) | 1 | $0.10 / job / month | > 3 jobs on the billing account (check other projects too) |
| Cloud Monitoring (built-in Cloud Run metrics) | Free | Viewing only; **no alert policies** (V22) | — | Alert policies may be charged | Any alert policy exists |
| Cloud Billing budgets / spend cap | Free | 2 budgets | — | — | — |
| Kill switch only (2B): Pub/Sub, Cloud Run functions, Cloud Build, Eventarc | Pub/Sub 10 GiB; functions 2 M invocations; Cloud Build 2,500 build-min (verify) | A few messages/day; 1–2 builds ever; function image ~100 MB in `gcf-artifacts` | > 99%, but the image shares the 0.5 GB AR allowance | Billed | AR size (includes `gcf-artifacts`) |
| Domain mapping + managed certificate | Free | 1 mapping | — | — | Preview status changes (R4) |

## Google Cloud: backup project
| Service / meter | Free limit | Expected use | Headroom | When hit | Warning signal |
|---|---|---|---|---|---|
| Cloud Storage, Standard, us-east1 | 5 GB-month (V24) | 35 dumps × ~1–5 MB ≈ < 200 MB | > 95% | ~$0.02/GB-month | Bucket > 1 GB |
| Class A operations (writes) | 5,000 / month | ~30–100 (one upload per night from the `shoestring-backup` job) | > 98% | $0.05 / 10,000 | — |
| Class B operations (reads) | 50,000 / month | A few (restore drills) | > 99% | tiny | — |
| Egress (restore downloads) | 100 GB / month from North America | < 50 MB | > 99% | ~$0.12/GB | — |
| Soft delete | Off (0 days) | — | — | Would bill deleted objects for 7 days | `softDeletePolicy` ≠ 0 |

## Neon (no card: limits cause outages, never bills)
| Meter | Free limit | Expected use | Headroom | When the limit is hit | Warning signal |
|---|---|---|---|---|---|
| Compute | 100 CU-hours / project / month | ~25–35 CU-h (≈ 20 wake episodes/day × ~8 min × 0.25 CU, plus nightly backup and purge wakes) | ~65% | Compute suspended until next month: API 503, SPA still loads | Usage page > 70 CU-h; **always-on would be ~182 CU-h** (V23) |
| Storage | 0.5 GB or 1 GB / project (V7) | < 50 MB year one | > 90% | Writes fail | > 70% |
| Egress | 5 GB / month | < 400 MB (API reads + 30 dumps) | > 90% | Throttled or blocked (verify) | > 3.5 GB |
| Branches / projects | Plan limits (V7) | 1 branch, 1 project (2 during a drill) | — | Cannot create | — |

## Other free services
| Service | Free limit | Expected use | Headroom | When hit | Warning signal |
|---|---|---|---|---|---|
| GitHub Actions (public repo) | Unlimited minutes on standard runners | CI + deploys (backups run in GCP, not Actions) | — | — | Spending limit stays $0 |
| GitHub Actions artifacts | Not used for anything sensitive | Playwright traces on failure only (ci-engineer) | — | — | — |
| GHCR (public package) | Free for public packages | 1 image per main build | — | — | Package visibility stays public; no secrets in images |
| Sentry (Developer) | ~5,000 errors / month, 1 cron monitor (V18) | < 200 errors; 1 monitor (`purge`) | ~95% | Events dropped until next period (no bill with $0 PAYG) | Usage > 70%; spike-protection emails |
| Better Stack Uptime | ~10 monitors, ~10 heartbeats (V19) | 1 monitor, 1 heartbeat | — | Cannot add more | — |
| Resend | 100 / day, 3,000 / month, 1 domain (V20) | < 100 / month | ~97% | Sends rejected: invites, resets and security notices fail, and recovery is blocked (F-09) | **Alert A6** at 80 sends in a day (Sentry, observability/README.md); dashboard > 2,000 / month |
| HIBP Pwned Passwords range API | Free, no key | ~1 call per signup/password change | — | — | — |
| Cloudflare (DNS) | Free plan | 1 CNAME (DNS only), 4 email records, 1 verification TXT; proxy and Workers only under the §3a fallback (Workers 100,000 requests/day, V28) | — | Fallback Worker over its quota fails requests (no bill on Free) | Any paid add-on |
| Domain | Owner's existing domain | — | — | — | Renewal is the owner's existing cost, not this app's |

## Total
| | Expected | Worst realistic case |
|---|---|---|
| Monthly | **$0.00** | A few dollars to low tens of dollars during a sustained request flood, until the spend cap or kill switch acts (Risk R1). Neon, Sentry, Resend and Better Stack cannot bill. |

## Changes that would raise cost (flag before doing them)
- Any `--min-instances` > 0, `--no-cpu-throttling`, or max instances > 2.
- A load balancer, Cloud Armor, Cloud SQL, Memorystore, Cloud NAT, a VPC connector, or a static IP.
- Enabling Container Scanning, Cloud Trace at volume, or Cloud Monitoring alert policies.
- Raising log retention above 30 days, or routing logs to BigQuery.
- Moving the backup bucket out of us-east1 / us-central1 / us-west1, or turning soft delete back on.
- More than one other project on the same billing account using Cloud Run, Artifact Registry or Cloud Storage.
- A paid plan anywhere, or adding a card to Neon.
Any of these needs an ADR (ARCHITECTURE.md "Cost").
