# Acceptance map: criteria → tests

Every acceptance criterion (journeys J1–J7 in docs/ARCHITECTURE.md, the "Great"
bar in the root CLAUDE.md, the NFRs) and every security finding or checklist
item with a test, mapped to the test file and test name. **Untested** items say
why and who covers them instead. Paths are relative to `tests/`; Playwright
files run on the iPhone WebKit, Pixel Chromium and desktop Chrome projects
unless marked. Keep this file current when tests are added or renamed.

## "Great" (root CLAUDE.md, ARCHITECTURE "Purpose")
| Criterion | Test |
|---|---|
| Quick-add takes 3 taps | `e2e/j2-quick-add.spec.ts` › "adds a transaction in 3 taps and under 10 seconds; totals update" (`taps.count === 3`) |
| …under 10 seconds | same test (wall time from the first tap to the updated total < 10 s, emulated devices) · **real phone, one-handed:** `RELEASE-CHECKLIST.md` §1 |
| …one-handed | **Untested automatically** (ergonomics). Owner check, `RELEASE-CHECKLIST.md` §1; 44 px targets come from axe and the frontend's unit tests |
| Totals are always right | `integration/money-and-months.test.ts` › "property: the summary equals an independent model…", "month summary formulas (ADR-0004)" (whole describe) · `integration/splits.test.ts` › "property: any partition…" · `e2e/j3-j5-month.spec.ts` › "planned, spent and remaining…" · coverage gate on money/split/month logic is in `make check` (db, backend, frontend) |
| Financial data never leaks between budgets | `integration/isolation.test.ts` (whole file) · `integration/permission-matrix.test.ts` (generated) · db's two-household DAL suite (`db/src/isolation.test.ts`, data-engineer) |
| …or into logs | **Not in tests/.** Backend redaction unit tests (F-07, `backend/src/logging.test.ts`); log review is security-reviewer's |
| …or onto the device | `e2e/sessions.spec.ts` › "nothing but the theme and the last budget ID is stored on the device (C3.4), through J2 quick-add too", "after sign-out, Back (a fresh load) shows no budget data and the session is gone" |

## Journeys
| Journey / acceptance | Test |
|---|---|
| **J1** invite link → account → first budget → overview | `e2e/j1-onboard.spec.ts` › "invite link → account → first budget with limits → overview" |
| J1 one atomic `POST /budgets` (budget, categories, this month's plan) | same test (plan has 3 entries) · `contract/operations.test.ts` › "createBudget answers…" · `integration/money-and-months.test.ts` › "today and the current month follow…" (starter plans land in the budget's month) |
| J1 works at 320 px | `e2e/j1-onboard.spec.ts` › "fits without horizontal scrolling, and the budget takes the device's timezone" (iPhone project) |
| J1 budget timezone defaults to the device's | same test (`timezoneId` America/Los_Angeles → budget timezone) |
| J1 invite token out of the URL first | same J1 test (`location.hash === ""`) · C3.6 below |
| **J2** + → amount → category → Save | `e2e/j2-quick-add.spec.ts` › "adds a transaction in 3 taps…" |
| J2 amount opens the numeric keypad | same test (amount focused on open, `inputmode="decimal"`) · real keypad: `RELEASE-CHECKLIST.md` §1 |
| J2 date defaults to today in the budget timezone | same test (stored date = `Budget.today`) · `integration/money-and-months.test.ts` › "today and the current month follow the budget timezone" (11 instants incl. DST and year end) |
| J2 Save retries safely with the same Idempotency-Key | `integration/idempotency.test.ts` (whole file, incl. "ten concurrent submits with one key create exactly one transaction") · frontend unit tests (key reuse in the form) |
| J2 leaves nothing on the device (C3.4, F-54) | `e2e/sessions.spec.ts` › "nothing but the theme and the last budget ID is stored on the device (C3.4), through J2 quick-add too" (storage checked with an unsaved draft open and after a save with a payee) · user binding of the in-memory draft and return path: frontend unit tests (`draft-stash.test.ts`, `return-path.test.ts`) |
| J2 nothing typed is lost on failure | `e2e/j2-quick-add.spec.ts` › "the sheet passes axe, and Save without a category keeps the input…" · offline/5xx retry: `RELEASE-CHECKLIST.md` §2 and frontend unit tests |
| J2 splits must sum, "left to assign" | `e2e/j2-quick-add.spec.ts` › "a split shows what is left to assign and saves only when it adds up" · `integration/splits.test.ts` › "split sums" |
| **J3** planned/spent/remaining per category and in total | `e2e/j3-j5-month.spec.ts` › "planned, spent and remaining per category and in total; refunds reduce spent; overspending is said in words" |
| J3 numbers only from the summary; a refund reduces spent | same test · `integration/money-and-months.test.ts` › "a refund larger than the spending…", "expense: spent = outflows - refunds…" |
| J3 overspending visible without colour | same e2e test ("1 category over", "Over by $50.00", table "(over)") |
| J3 month boundaries follow calendar dates | same e2e test (October) · `integration/money-and-months.test.ts` › "a transaction's month is its calendar date, whatever the budget timezone" |
| **J4** grouped by day, filter by category, paging | `e2e/j4-review.spec.ts` › "grouped by day, paged with Load more, filtered by category" · `integration/paging.test.ts` (whole file) |
| J4 edit incl. splits, delete updates totals | `e2e/j4-review.spec.ts` › "edit a transaction into a split, then delete it; the overview follows" · `integration/money-and-months.test.ts` › "editing and deleting a transaction updates the totals at once (J4)" |
| J4 conflict shows VERSION_CONFLICT, never overwrites | `e2e/j4-review.spec.ts` › "an edit that raced another member's edit shows the conflict and does not overwrite it" · `contract/check-order.test.ts` › "step 13 before step 14" |
| **J5** copy fills only empty categories; archived skipped | `e2e/j3-j5-month.spec.ts` › "next month starts empty; copying fills the limits but skips archived categories" · `integration/money-and-months.test.ts` › "copies across the year boundary, fills only empty entries…" |
| **J6** owner invites (re-auth) → partner signs up via sign-up invite → accepts → both see each other's transactions | `e2e/j6-share.spec.ts` › "invite (with re-auth) → partner signs up and accepts → both see each other's transactions" · `integration/invitations.test.ts` |
| J6 transfer, delete, undo; members emailed on deletion and restore | `e2e/j6-share.spec.ts` › "the owner transfers ownership; the new owner deletes the budget and restores it" · `integration/owner-member.test.ts` › "leaving, removal and ownership transfer (ADR-0010)" |
| J6 non-members 404; owner-only actions | `integration/permission-matrix.test.ts` (generated) · `integration/owner-member.test.ts` |
| **J7** enable TOTP/passkey, recovery codes, sign in with second factor | `integration/security/mfa-success.test.ts` (API, real Postgres). **No browser test yet**: needs the Chromium CDP virtual authenticator and a TOTP entry through the UI; proposed for the next round |
| J7 reset demands the second factor | `integration/security/password-reset-mfa.test.ts` |
| J7 "this wasn't me" undoes an email change | `integration/security/f33-email-change.test.ts` · `e2e/sessions.spec.ts` › "an email-change undo link: location.hash is empty" |
| J7 re-auth for sensitive actions; new sign-ins emailed; device list; 90-day cap | `integration/permission-matrix.test.ts` (stale re-auth rows) · `integration/security/notification-emails.test.ts` (F-34) · `integration/account-matrix.test.ts` › "own sessions only" · 90-day cap: **untested here** (DB CHECK + db unit tests; a frozen-clock API test can be added) |

## Non-functional requirements (ARCHITECTURE)
| NFR | Test or owner |
|---|---|
| First load LCP < 2.5 s | **Not in tests/**: Lighthouse CI on the production build (ci-engineer) |
| Repeat load from the service worker < 1 s | **Untested**: no SW in e2e (blocked by design, ADR-0009); `RELEASE-CHECKLIST.md` §2 and a future prod-build job |
| JS/CSS/font budgets | `make check` (frontend `check-dist`) |
| API latency p95 | **Untested in tests/**: EXPLAIN checks in db; production logs (sre). A perf test with 2,000 transactions is a candidate for a later round |
| Quick-add 3 taps < 10 s on 375 px | J2 above (iPhone 13 390 px and Pixel; 375 px in the visual suite) |
| WCAG 2.2 AA, axe serious/critical | every journey screen: `expectAccessible(...)` calls in `e2e/*.spec.ts` (sign-up, create budget, overview chart and table, quick-add sheet, split editor, transactions, edit conflict, categories, members, re-auth dialog, my invitations, delete confirmation, sign-in, reset password) · manual VoiceOver/TalkBack: `RELEASE-CHECKLIST.md` §4–5 |
| Browsers: iOS Safari, Android Chrome, desktop Chrome | the three Playwright projects; real devices: `RELEASE-CHECKLIST.md` |
| Correctness (100% branch coverage on money/split/month) | `make check` coverage gates (db, backend, frontend) |
| Isolation | see "Great" above |
| Durability, availability, cost, cold start | **Not in tests/** (sre runbooks, drills, alerts) |
| Data rights: CSV export, deletion grace | `contract/operations.test.ts` › "exportMyData…", "requestAccountDeletion…", "cancelAccountDeletion…" · `integration/account-matrix.test.ts` › "account pending deletion (auth.md §11)" · CSV in the installed app: `RELEASE-CHECKLIST.md` §2 · purge: db purge tests |

## Contracts
| Contract | Test |
|---|---|
| api.openapi.yaml: every operation's success and error path | `contract/operations.test.ts`; every response in tests/ through the oracle (`support/contract.ts`, self-test `contract/oracle.test.ts`) |
| Generated requests never 5xx / off-contract | `contract/generated.test.ts` |
| Unknown routes and methods → 404 | `contract/routes.test.ts` |
| Unknown fields / query params, 413, 415, malformed JSON | `contract/rejections.test.ts` |
| GET and HEAD bodies ignored (errors.md "Request bodies") | `contract/rejections.test.ts` › "a body on GET is ignored…" (every GET operation × JSON, malformed, text/plain, form, over 64 KiB) · `contract/routes.test.ts` › "request bodies on GET are ignored" · the oracle refuses 413/415 on GET (`contract/oracle.test.ts`) |
| errors.md prose ↔ `x-error-codes` (a code the registry assigns to a named operation, e.g. MFA_REQUIRED for `/auth/reauth` and `/auth/password-reset/complete`, is in that operation's `x-error-codes`) | `contract/oracle.test.ts` › "every code errors.md assigns to a named operation in prose is in that operation's x-error-codes" |
| errors.md check order | `contract/check-order.test.ts` |
| auth.md §13 matrices | `integration/permission-matrix.test.ts`, `integration/account-matrix.test.ts` |
| auth.md §15 notification vocabulary | every test (`support/setup.ts`, `e2e/fixtures.ts`) · `integration/security/notification-emails.test.ts` |

## Security findings and checklist items with tests
| ID | Test |
|---|---|
| F-01 one-time tokens die with recovery | `integration/security/f33-email-change.test.ts` › "an attacker's revocation events … never delete the victim's cancel link (F-01)" · `integration/security/password-reset-mfa.test.ts` › "enrolling a factor deletes an open reset token…" |
| F-05 / F-45 MFA failure budget and attempt slots | `integration/security/f45-mfa-attempt-slots.test.ts` (whole file) |
| F-06 / C3.6 fragment tokens out of the URL | `e2e/sessions.spec.ts` › "emailed link tokens leave the URL at once (C3.6, F-06)" · `e2e/j1-onboard.spec.ts` |
| F-09 email budget, priority mail | `integration/security/notification-emails.test.ts` › "F-09: past 60% of the daily email budget…" |
| F-09 per-address and per-IP reset-request limits | `integration/security/f09-reset-request-limits.test.ts` › "per address: 3 mails an hour and 5 per 24 h, from any IP, then silent 202s that look the same", "per IP: the 6th request in an hour is 429 with Retry-After; another IP is not limited". The owner alert at 60% (Sentry) is not testable here (sre) |
| F-12 / F-34 new-sign-in notice on every sign-in | `integration/security/notification-emails.test.ts` › "F-34: every successful sign-in sends new_sign_in…" |
| F-13 invite and transfer need re-auth | `integration/permission-matrix.test.ts` › "… × owner with re-auth older than 10 minutes → 403 REAUTH_REQUIRED" · `e2e/j6-share.spec.ts` (re-auth dialog) |
| F-18 / C8.4 isolation | `integration/isolation.test.ts`, `integration/permission-matrix.test.ts` |
| F-20 / F-21 session caps, login lockout | `integration/security/f21-login-lockout.test.ts` › "10 failures from one IP lock only that pair: the owner still signs in from another IP", "an IPv6 pair is keyed by the /64…", "a successful reset clears the pair counter of the IP that completed it", "100 failures from many IPs lock the email everywhere (login_throttled); a successful reset clears that counter" · `contract/check-order.test.ts` › "login (20 attempts / 15 min per IP)…" · `integration/security/notification-emails.test.ts` (100 failures → `login_throttled`). Session caps (F-20): DB and backend unit tests |
| F-22 enumeration timing | `integration/security/f22-enumeration-timing.test.ts` › "password-reset request: an existing account and an unknown address both answer at the fixed 1 s", "email-change request: a taken address and a free one both answer at the fixed 1 s" (6 samples per group, run together; every answer ≥ 950 ms, medians within 250 ms, below 2 s; the known path's mails proven sent) · `integration/invitations.test.ts` › "the create call takes about the same fixed time…" |
| F-23 / C3.1 CSP | `integration/security/headers-and-csp.test.ts` (drift test, policy = ARCHITECTURE) · `e2e/csp-prod/csp-gate.spec.ts` (production build, zero `securitypolicyviolation`, both React Aria styles incl. iOS usePreventScroll; projects csp-prod-webkit and csp-prod-chromium) · the violation gate (`e2e/fixtures.ts`) applies only where a CSP is sent: the **csp-prod projects and the visual suite** (production build). The journey projects run on the Vite dev server, which sends no CSP, so they prove nothing about the policy |
| F-55 CSP gate sees every document | `e2e/fixtures.ts` collects violations in Node (`exposeBinding`) across navigations · self-check `e2e/csp-prod/csp-gate.spec.ts` › "a violation on an earlier page still fails the test after navigating away (F-55 self-check)" · `visual/screens.spec.ts` `snap()` drops only Playwright's own screenshot `<style>` (matched by its exact position in Playwright's helper) |
| F-56 local-only test environment | `support/env-guards.test.ts` (unit, `make check`): database URLs must be local (`parseDatabaseUrl`), origins loopback, no silent shell override of `tests/.env.stack`; enforced in `support/env.ts`, `support/db-env.ts`, `support/global-setup.ts` |
| C3.2 headers on every response | `integration/security/headers-and-csp.test.ts` (API route classes). SPA document, static files and the `index.html` fallback: **`make image-smoke`** (ci-engineer, F-53) checks every security header and the exact CSP `script-src`/`style-src` on `/`, an SPA deep link (served by the `index.html` fallback) and `/sw.js` (a static route) of the production image. Not in tests/: the e2e stack serves the frontend from Vite, which sends none of these headers (ADR-0009) |
| C3.3 cookie attributes | dev half: `integration/security/headers-and-csp.test.ts` › "C3.3 (dev half)". `Secure` / `__Host-`: **`make image-smoke`** and config unit test (backend) |
| C3.4 no API data on the device | `e2e/sessions.spec.ts` › "nothing but the theme and the last budget ID is stored on the device (C3.4), through J2 quick-add too" (localStorage keys and values, sessionStorage, IndexedDB, Cache Storage, httpOnly cookie; overview, J2 save, an open unsaved draft, transactions); SW cache contents: frontend `check-dist` + `RELEASE-CHECKLIST.md` §2 |
| F-51 sign-out only counts when the server confirmed it | `e2e/sessions.spec.ts` › "a sign-out the server never confirmed says so and keeps you signed in; the retry signs out and kills the session (F-51)" (logout request fails at the network level, then a 503: `sign-out-error` alert, still on /more, session still live; then the same button retries → /signin, the old cookie is 401) · frontend unit tests |
| C3.5 / F-32 sign-out and bfcache | bfcache path: `e2e/csp-prod/sign-out-back.spec.ts` on **csp-prod-chromium** (production build, full Chromium with bfcache on; asserts `pageshow.persisted === true` for the budget page, then no budget data and a 401 session) · fresh-load path: the same scenario (`e2e/sign-out-back.ts`) on csp-prod-webkit and in `e2e/sessions.spec.ts` › "after sign-out, Back (a fresh load)…" on the three journey projects. Playwright's WebKit never restores from bfcache, so iOS Safari's bfcache path rests on `RELEASE-CHECKLIST.md` |
| C3.7 CSRF token in memory, sent on unsafe requests | frontend unit test (C3.7's "verified by") · server side: `contract/check-order.test.ts` › "steps 3-4" (incl. "a valid X-CSRF-Token does not excuse the Origin check: foreign or cross-site → 403 CSRF_FAILED, and nothing is written") |
| C3.8 no third-party resources | partly: the CSP gate on the csp-prod projects and the visual suite (any third-party load would violate `default-src 'self'`) |
| F-08 client IP / proxy trust | `integration/security/f08-client-ip.test.ts` › "the login limit (20 attempts / 15 min per IP) trips although every attempt forges a new leftmost X-Forwarded-For", "the in-memory global limit (300 / minute per IP) trips although every request forges X-Forwarded-For", "security_events.ip is the edge's entry (IPv4 and IPv6), never a forged one", "IPv6 clients share one bucket per /64…". The e2e stack trusts exactly one hop (`TRUST_PROXY_HOPS=1`), the e2e edge, as production trusts the platform front end (tests/CLAUDE.md "Client IPs"). The production hop count itself (V26) is sre's; backend unit test (forged `X-Forwarded-For`) as before |
| F-33 email-change chain | `integration/security/f33-email-change.test.ts` |
| F-36 / C8.9 deleted-budget routes | `integration/permission-matrix.test.ts` › "deleted-budget routes (F-36, checklist C8.9)" |
| F-48 bidi controls | `integration/security/f48-bidi-controls.test.ts` (email defanging: backend unit tests) |
| PR #6 successful MFA against real Postgres | `integration/security/mfa-success.test.ts` |
| Password reset never bypasses MFA | `integration/security/password-reset-mfa.test.ts` |
| C15.7 synthetic data only | `tests/CLAUDE.md` rule; all fixtures use `@example.test` and invented names |

## Known gaps and pins
- **BUG-1** closed 2026-11-16: the contract now exempts GET and HEAD from the body rules (owner ruling); the tests assert the exemption.
- J7 in the browser (TOTP setup and passkeys through the UI) is API-tested only; next round.
- Service worker, install, offline and update: production-build checks and `RELEASE-CHECKLIST.md` §2 (no SW in dev e2e, ADR-0009).
