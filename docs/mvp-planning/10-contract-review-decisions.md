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
