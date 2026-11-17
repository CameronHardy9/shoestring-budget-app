# Sentry: check that nothing sensitive arrived, and purge it if it did
- Owner: sre · Runs: **owner** · Status: **DRAFT, pending first deploy** · Settings: observability/README.md "Sentry"; bootstrap-production.md step 11b
- Policy: Sentry events may contain only requestId, opaque user ID, route template, browser, release, error type and stack frames (ARCHITECTURE "Error tracking", F-06, F-07). **Anything else is a leak**: an email, name, amount, payee, memo, budget/category/passkey name, IP address, token, cookie, query string or fragment.

## When to use
- **After every alert you open** (error-spike.md, purge-failed.md, email-quota.md): spend one minute on step 1 for the event you are looking at.
- **After bootstrap and after any change** to the Sentry settings, the SDK setup in `backend/` or `frontend/`, or the Sentry SDK version: run the canary (step 2).
- **Monthly**, with the billing-protection.md §11 checks: run step 1 on the 5 issues with the most events in each project.
- **Whenever you see personal or financial data in Sentry**: go straight to step 3.

## 1. Check events for sensitive data
For each issue: Issues → the issue → the latest event → the **⋯** menu (top right of the event) → **JSON**. The raw event opens in a new tab. That is the stored payload, after scrubbing. Save it (⌘S) outside the repo, for example to `~/Downloads/event.json`. Then:
```sh
F=~/Downloads/event.json
jq '{user, request, tags, extra, contexts: (.contexts | keys?), crumbs: [.breadcrumbs.values[]? | {category, message, data}]}' "$F"
grep -Eoi '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}' "$F" | sort -u          # email addresses: expect none
grep -Eo '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' "$F" | sort -u                   # IPv4 addresses: expect none (version numbers can match; check each one)
grep -Eo '"(url|uri|abs_path|document_uri|blocked_uri)": *"[^"]*[?#][^"]*"' "$F"   # a URL with ? or #: expect none
rm "$F"
```
**Pass:**
- `user` has at most `id`. There is no `ip_address` and no `geo`.
- `request` has no `query_string`, `fragment`, `cookies`, `data`, or headers other than `User-Agent`.
- Tags are only `requestId`, `userId`, `route`, `release`, plus Sentry's own (`environment`, `level`, `browser`, `os`, `runtime`, `handled`, `mechanism`, `monitor.slug`).
- Breadcrumbs carry method, path and status only, never a query or a body.
- A `[Filtered]` value is a **pass**: the server-side scrubber caught it. Still tell the tech lead which field it was, because the SDK should not have sent it (defence in depth).

Anything else → step 3.

**Sentry's lookback on the free plan is 30 days** (sentry.io/pricing, checked 2026-11-16). Sentry stops showing events after that, so a leak older than 30 days can't be found here.

## 2. Canary: prove the scrubber settings work (synthetic data only)
Run this from your Mac. It sends one made-up event, never real data. Do it once per project (DSNs come from Sentry → project → Settings → **Client Keys (DSN)**).
```sh
cd "<repo root>"
export SENTRY_CANARY_DSN="<shoestring-api DSN>"
deploy/scripts/sentry-canary.sh              # dry run: prints the synthetic event, sends nothing
APPLY=1 deploy/scripts/sentry-canary.sh      # sends it; note the printed event_id
export SENTRY_CANARY_DSN="<shoestring-web DSN>"
APPLY=1 deploy/scripts/sentry-canary.sh
unset SENTRY_CANARY_DSN
```
Then, for each project: Issues → environment **`smoke`** (the environment picker at the top) → "Shoestring scrubber smoke test …" → the event → ⋯ → **JSON** → save as `~/Downloads/canary.json`:
```sh
grep -c SSCANARY ~/Downloads/canary.json      # must print 0: every synthetic sensitive value was removed
grep -c SSCONTROL ~/Downloads/canary.json     # must print 1 or more: the event really was stored and checked
jq '.user' ~/Downloads/canary.json            # no ip_address and no geo
rm ~/Downloads/canary.json
```
- **Pass:** both counts are as stated, and `user` has no `ip_address` or `geo`. Delete the canary issue (step 3a) so it doesn't sit in the issue list.
- **Fail:** stop. Re-check the Security & Privacy settings (bootstrap-production.md step 11b, S5). If they are correct and the canary still fails, tell the tech lead and security-reviewer **before** real users arrive.
- The canary uses environment `smoke` and level `info`, so the production alert rules (`environment = production`) stay quiet.

## 3. A leak was found: purge it
Do these in order. Note the issue IDs, field names and times, but **don't copy the leaked values anywhere** (not into notes, chat or tickets).
1. **Delete the issue, which deletes all of its events.** Sentry can't delete a single event (docs.sentry.io "Server-Side Data Scrubbing" → Removing Data, checked 2026-11-16). Issue → **⋯** (or the trash icon) → **Delete** → confirm. Repeat for every issue that holds the data. Find them with the Issues search, for example `has:user.email`, `has:user.ip`, or the tag key that held the data.
2. **If the data was in a tag:** deleting events is not enough. Project → Settings → **Tags & Context** (or "Tags") → find the tag key → **Delete** (removes every value of that key). Do it in both projects if needed.
3. **If many issues across the project contain the data**, delete and recreate the project:
   - Project → Settings → General → **Remove Project**, then create it again with the same name and platform (step 11b, S3–S4).
   - It gets a **new DSN**: put it where step 11b, S8 says (`SENTRY_DSN` on Cloud Run, or the `SENTRY_DSN_WEB` repository variable plus a new CI build and deploy).
   - Recreate the alert rules and the cron monitor for that project (step 13).
4. **Stop the source.**
   - Add the field to the org's **Additional Sensitive Fields** (Org → Settings → Security & Privacy) if a key name would catch it. Remember that a word there also removes any value that **contains** the word.
   - Or add an Advanced Data Scrubbing rule (same page), for example `[Remove] [Anything] from [extra.<key>]`.
   - Then tell the tech lead, so the SDK allowlist is fixed (backend-engineer or frontend-engineer) and security-reviewer reviews it.
5. **Treat it as a security incident.** The tech lead and security-reviewer decide whether users must be told. Draft a postmortem in docs/runbooks/incidents/ (no leaked values in it).

## Verify
- The Issues search that found the leak returns nothing.
- After the fix, run the canary (step 2) again, and step 1 on the next real event of the affected type.

## Back out
Nothing to back out. Deleted issues and events can't be restored, by design. A new event of the same kind creates a fresh issue.
