# Contract review decisions (2026-11-12)
These are the owner's rulings on the gaps the architect raised, the security review (docs/security/FINDINGS.md, F-01 to F-32) and the SRE hosting evaluation (infra/hosting-evaluation.md). They are binding on the contract revision.

## Product gaps (architect)
| Topic | Decision |
|---|---|
| Income and refunds | **Keep** `kind: expense|income` and `direction: outflow|inflow`. A refund is an inflow in an expense category and reduces "spent". |
| Category management | **Members can** create, rename, archive and delete unused categories. |
| Ownership | **Add ownership transfer.** The owner can hand ownership to another member, then leave the budget or delete their account. |
| Limits | **Accepted:** 10 budgets per user, 6 members, 10 pending invitations, 100 categories, 20 splits, $1M maximum amount, 12-character minimum password, sign-up invites expire after 7 days and budget invites after 14, no zero-amount transactions, RTO 4 h best effort. |
| Other architect calls | Accepted as drafted: budget deletion requires re-auth, only the owner changes the timezone, the sign-up invite counts as email verification, budget invites can be sent to people who don't have an account yet, and a login counts as re-auth for 10 minutes. |

## Security owner decisions
| ID | Decision |
|---|---|
| OD-1 Owner MFA | **MFA stays optional for everyone**, including owners of shared budgets. This was recommended against; it is an accepted risk (R-1). The non-MFA mitigations from F-12 and F-13 still apply. |
| OD-2 Session cap | **90-day absolute session lifetime**, on top of the 30-day sliding expiry |
| OD-3 Admin commands | Run as **Cloud Run jobs**, never in public GitHub Actions. purge may use a scheduler with counts-only output. |
| OD-4 Backups | Encrypted with **age** (public key only in CI) and written to a **private GCS bucket** in a separate project, with a 34-day lifecycle (sre design) |
| OD-5 Deleted budgets | **Self-service undo:** the budget owner can restore a deleted budget in the app within the 30-day grace period. Members receive a deletion notice. |
| OD-6 Public repo | Design-phase findings stay public. **After launch**, open Critical and High findings go to private GitHub security advisories; add SECURITY.md and private vulnerability reporting. |
| OD-7 Residual risks | **Accepted, 2026-11-12:** R-4 co-members fully trusted, R-5 third-party PII exposure, R-6 IPs kept 90 days, R-8 one human reviewer, R-10 denial of wallet |
| OD-8 Legal | **Accepted as unassessed** for a free friends-and-family beta; revisit before any wider launch |
| FINDINGS.md | The tech lead wrote it from the security-reviewer's returned content (the subagent's write was blocked), with owner approval |

## Hosting and operations (sre)
| Topic | Decision |
|---|---|
| Platform | **Cloud Run (us-east1, request-based billing, scale to zero, max 2 instances) + Neon free Postgres (aws-us-east-1)**. The owner accepts risk R1: a traffic flood could cost a few dollars, up to the low tens, before the cap stops it. |
| Hard cap | A **Cloud Billing spend cap**, not the destructive kill switch (fallback only) |
| DNS | **Cloudflare**, which allows a Cloudflare proxy as the fallback for domain mapping and partial flood protection |
| Alerts | The agreed two (down, error spike) **plus** missed backup, failed purge and billing. Push notifications through the Sentry mobile app and Better Stack. |
| Email | Resend on `mail.<domain>` (Brevo fallback), with click and open tracking off and DMARC on the sending subdomain |

## CI (ci-engineer)
| Topic | Decision |
|---|---|
| pnpm | **10.34.9** with its supply-chain settings (blocked build scripts, 7-day minimum release age, no-downgrade trust policy) |
| Workflow permissions | `permissions: {}` by default, granted per job |

## Round 2 decisions (2026-11-13)
| Topic | Decision |
|---|---|
| ADR-0009 (e2e against dev servers) and ADR-0010 items 3–4 (row locks, purge rules, `revoke-sessions --all`, `security-events`) | **Approved** |
| Ownership transfer | **No acceptance step.** Takes effect immediately and every member is notified. |
| Soft-deleted budgets and the 10-budget limit | **They do not count** toward the limit. A restore is refused if the owner is already at 10 budgets. |
| R-11: the old mailbox can revert a confirmed email change for 24 h | **Accepted**, together with the F-33 fix and notices to both addresses |
| Nightly backup location (F-17) | **A Cloud Run job** in Google Cloud. The database credential never enters GitHub. |
| How admin commands get the target email (R-12) | **Accept emails in `--args`**. They stay in owner-only GCP job records and audit logs for about 400 days; disclose this in the privacy notice. No input-secret mechanism. |
| MFA encryption key | An offline **escrow copy** in a separate password-manager vault |
| User notice after a restore | **Sent manually** by the owner (BCC) until a CLI command exists |
| Cloudflare proxy fallback | Switched on **only after a security review** |
| GitGuardian false positives in PR #1 | **Remove literal passwords.** Local and test database passwords are generated, never committed. |

## Round 3 decisions (2026-11-13)
| Topic | Decision |
|---|---|
| Backup heartbeat URL | **Plain env on the job** (not a secret), so the last free Secret Manager slot stays spare. Accepted. |
| The spend cap pauses backups and purge | **Accepted.** Backups stay in the app project; the backup project and bucket get alerts only, no cap. After the cap lifts, purge and backup are run by hand. |
| GitGuardian on PR #1 | The literal passwords are removed in a follow-up commit. The original commit's incidents are resolved by the owner in the GitGuardian dashboard, or the PR is squash-merged. |

## Build round 1: data layer (2026-11-13)
| Topic | Decision |
|---|---|
| Split → category FK | **Accepted:** `DEFERRABLE INITIALLY DEFERRED NO ACTION` instead of RESTRICT (RESTRICT breaks the purge cascade). `deleteCategory` still returns CATEGORY_IN_USE. The architect amends data-model.md. |
| Data-engineer gap resolutions | **All four accepted:** (1) re-inviting an email whose invitation expired replaces it; (2) the pending-invitation limit counts only unexpired invitations; (3) transferring ownership to a member pending account deletion returns NOT_FOUND; (4) cancelling an email change is a "revert" when the account's email is still the address the cancel link was sent to. Recorded in the contracts by the architect. |
| Production migrate job + restore.md step 5 (roles.sql as DB owner) | **Deferred to the pre-deploy pass** (ci-engineer + sre). |
| Pacing | **Each area waits for the owner's merge** before the next area's branch starts from `main`. |
| Security review of db/ | No Critical/High. F-41 (Medium) and F-42–F-44 (Low) fixed in the same PR. |

## Build round 2: backend (2026-11-14)
| Topic | Decision |
|---|---|
| Architect contract revision (auth.md rev 4, errors.md, data-model.md, test-hooks.md, OpenAPI global rules) ratifying the backend's choices | **Approved.** |
| Deleted-budget restore race (restore can revive a shared budget whose owner just requested deletion; purge alert catches it) | **Deferred** to a later PR; tracked as a security finding. |
| `TRUST_PROXY_HOPS` in production | **Refuse 0** (must be at least 1). |
| Email the owner when a member leaves on their own | **No** (the member list shows it). |
| "Account created" notice on sign-up | **No** (the invite link already proves the mailbox). |
| F-45 (Medium, MFA failure limits can be raced) | **Fix in the backend PR**, before merge. |
| Owner of `.env.example` | **ci-engineer** (added to the CLAUDE.md table). |
| F-48 follow-up: Unicode bidi controls in user text | **Banned at input** (API 400 + database `is_clean_text`), and also stripped in emails. U+200D (emoji) stays allowed. |

## Build round 3: frontend style (2026-11-14)
| Topic | Decision |
|---|---|
| Visual direction (frontend/design/style-proposal/) | **Approved as shown.** |
| Brand colour | **Indigo** (#4F46E5 light / #A5ACFF dark). |
| Font | **Self-hosted Inter** (variable, ~48 KB), not system fonts. |
| React Aria's two injected `<style>` blocks vs CSP `style-src 'self'` | **Allow the two exact sha256 hashes** in `style-src` (no `'unsafe-inline'`, no nonce). Security sign-off in the frontend PR review. |
| "Save & new" in quick-add | Kept next to Save (engineer's default; owner did not object). |
| Quick-add default category | **No pre-selection** (tap + → amount → category → Save). || Category reordering | **After the MVP** (server order; quick-add chips already put recent categories first). |

## Build round 4: frontend security review (2026-11-14)
| Topic | Decision |
|---|---|
| CSP sign-off (two React Aria hashes) | **Signed off** by security-reviewer; recorded in FINDINGS. |
| F-51 (sign-out ignores a failed logout while offline) | **Follow-up hardening PR before launch.** |
| F-50 (link-token capture not first in the production bundle) | **Hard requirement of the Sentry integration PR** (no exposure until Sentry exists). |
| F-52, F-53, F-54 | **One hardening PR before launch**, together with F-51. |

## Build round 5: test suite (2026-11-16)
| Topic | Decision |
|---|---|
| F-55 (CSP gate loses violations on navigation), F-56 (test DB URLs not forced local), F-32 bfcache assertion | **Fix in the test-suite PR** before merge. |
| BUG-1 (GET ignores a request body) | **Exempt GET and HEAD** from the body rules in the contract; no backend change. |
| GitGuardian on PR #13 (incident 40152085, generated test passwords) | **False positive**, marked by the owner in the GitGuardian dashboard. No code change; tests/ stays scanned. |
| Dependabot #11 (TypeScript 7) | **Closed.** typescript-eslint doesn't support TS 7 yet; stay on TS 6. ci-engineer makes Dependabot skip TypeScript majors until it does (hardening PR). |

## Build round 6: pre-launch hardening, PR #14 (2026-11-16)
| Topic | Decision |
|---|---|
| F-57 (read-then-increment races in reset, email-budget, invite and email-change limits) | **Fixed in PR #14** (reserve-first). Found during hardening; tech lead added it to scope as a gap in F-09 and in the $0 email quota. |
| F-58 (`login_throttled` notice can be skipped under concurrency) | **Notice fix in PR #14.** Converting the login failure counters to reserve-first is **deferred**: the overshoot is bounded (about 2×) and security accepts it for launch. |
| "Reload" after an update reloads every tab | **Keep as is** (all tabs reload). |
| /more loading layout shift; quick-add + ignored while the budget loads | **Follow-up frontend PR** after #14. |
| 300 ms API p95 guard | **The EXPLAIN row-count check is enough** at beta scale; no API-level timing test. ARCHITECTURE updated to match. |
| F-22 slow-mailer test hook | **Not added** (security: the 1 s pad floor test plus the mailer timeout test cover it, and a hook would widen the test-hook surface). |

## Build round 7: loading tap targets (2026-11-16)
| Topic | Decision |
|---|---|
| Quick-add chip order after "Save & new" | **Freeze the order while the sheet is open.** The just-used category moves to the front the next time quick-add opens, so no tap can land on a chip that moved. |
| Recent-transactions query that sets chip order | **Prefetch it in BudgetLayout** so chips are usually ready when + is tapped (one extra small request per budget page; $0). |
| Saving while the phone knows it's offline | **Fail fast** ("online to save"): Save fails at once with the offline message, the sheet keeps the entry, and the person saves again when back online. Separate frontend PR. |
| Other screens showing an endless loader offline with nothing cached (Overview summary, Transactions, Categories, Sessions, Deleted budgets, Invitations, Security) | **Fix in the same offline PR**, so offline is handled consistently. |

## Build round 8: Sentry integration (2026-11-16)
| Topic | Decision |
|---|---|
| Phone push for alerts A2 (error spike), A3 (purge), A6 (email quota) | **Gmail push.** Sentry emails the alerts; a Gmail filter plus Gmail app notifications push them, the same path as the GCP budget alerts. (Sentry's mobile app is unavailable in the US App Store; Slack/webhooks are paid.) |
| Per-key (DSN) rate limit, paid-only on Sentry | **Spike protection only**, plus the hard 5,000 errors/month free quota. No SDK-side cap. Exhausting the quota can't cost money; Sentry is blind until the 1st. |
| Usage budget | **One local `make e2e` per PR**, CI for the rest unless there is a concrete reason; **fresh specialist agents per PR** with a context handoff. |
| Browser error messages sent to Sentry | **Allowlist known-safe message patterns** (owner overrode the "strip all" recommendation). Everything not matching a reviewed safe pattern is still dropped; the patterns need security-reviewer sign-off because a wrong pattern could leak data quoted from the API. |
| F-60 (no owner alert at the 60% cutoff where password-reset and invitation mail stops) | **Move the Sentry email-quota warning to 60%** (error stays at 100%). Follow-up PR before launch. |
| F-59, F-60, F-61 (Lows from the Sentry review) | **Small follow-up PR** right after the Sentry PR, before launch. |
