# Meeting 5: test-engineer
Status: **meeting held 2026-11-12**

## Agent's agenda

### Proposed MVP test strategy
- **About 6 e2e journeys:**
  1. Sign up, log in, log out
  2. Add a transaction on a phone in a few taps
  3. Create a budget and categories
  4. Monthly overview shows the right "remaining" amount, including month boundaries
  5. Editing or deleting a transaction updates the totals
  6. Error paths: session expiry and bad input
- **Data isolation is mandatory:** user A can never see or change user B's data. Tested at the API level and once in the browser.
- **Mobile by default:** WebKit at iPhone size and Chromium at Pixel size first, then desktop Chrome. Covers touch, the on-screen keyboard covering fields, and the numeric keypad for amounts.
- **Contract tests:** real responses checked against api.openapi.yaml, errors.md and the 401/403 cases in auth.md.
- **Integration tests:** API plus a real database in compose, a new user per test from factories, frozen time.
- **Money:** whole cents, with tests for rounding, negative amounts and currency display.

### Decisions for the owner
1. **E2E framework:** (a) Playwright *(recommended)*, (b) Cypress (no real WebKit), (c) WebdriverIO + Appium
2. **Browser and device coverage:** (a) emulation only *(recommended now)*, (b) emulation on every PR plus a nightly run on real devices via BrowserStack or Sauce Labs, about $100–200 a month *(before real users)*, (c) real devices on every PR
3. **Visual regression:** (a) Applitools (paid), (b) Playwright screenshots in a fixed Docker image *(recommended: about 6 screens at 2 phone sizes)*, (c) none
4. **Accessibility testing:** (a) axe checks in e2e, failing on serious or critical issues, plus a manual VoiceOver/TalkBack checklist each release *(recommended)*, (b) axe only, (c) defer
5. **Coverage gates:** (a) report only, (b) every journey passes, at least 80% of changed lines covered, 100% branch coverage on money and date logic *(recommended)*, (c) 80% overall
6. **Contract testing:** (a) OpenAPI validation plus Schemathesis-style generated requests *(recommended)*, (b) Pact

### Draft task list
1. tests/CLAUDE.md: layout, how to run one test, test-data rules
2. Test setup: factories, per-test database reset, frozen time, a login helper that only works in test mode
3. Contract test suite covering success and error cases
4. Integration tests: isolation, budget and transaction rules, money math
5. Playwright e2e for the journeys on phone and desktop projects
6. Screenshot baselines and axe scans
7. A map from acceptance criteria to tests
8. Security regression tests as findings are filed
9. Keep `make e2e` under about 10 minutes in CI

### Dependencies
architect (journeys, device list, OpenAPI, auth) · ci-engineer (`make e2e`, Playwright in CI, artifacts) · data-engineer (seed and reset hooks) · backend (a test-only clock and test login, both off in production) · frontend (test IDs and accessible names, animations off in tests) · security-reviewer

### Risks and open questions
- Emulation misses some real iOS Safari bugs; installed-app (PWA) and offline modes need testing if they're in scope
- Bank sync would need sandbox fixtures
- Timezone and DST bugs; screenshot baselines must be generated in Docker
- Only synthetic data in tests
- Which currencies and locales does the MVP support?

## Owner decisions (2026-11-12)
Settled by earlier meetings: **$0 cost**, so no Applitools or paid real-device services · USD only, en-US locale · shared budgets · splits included · MFA.

| Decision | Choice |
|---|---|
| E2E framework | **Playwright** |
| Device coverage | **Emulation only**: iPhone-sized WebKit, Pixel-sized Chromium, desktop Chrome. Plus a **manual smoke test on the owner's phone** before each beta release. |
| Visual regression | **Playwright screenshots** in a fixed Linux container: about 6 key screens at 2 phone sizes, starting after the owner approves the visual style |
| Accessibility | **axe in e2e** (fails on serious or critical issues) **plus a manual VoiceOver/TalkBack checklist** each release |
| Coverage gates | **Targeted:** all journey tests pass, at least 80% of changed lines covered, 100% branch coverage on money, split and month logic |
| Contract testing | Agent default: OpenAPI response validation plus generated requests (Schemathesis-style) |

## Agreed tasks (updated for the decisions above)
1. tests/CLAUDE.md: layout, how to run one test, test-data rules
2. Test setup: factories, per-test database reset, frozen time, a login helper that only works in test mode (including MFA)
3. Contract suite covering success and error paths
4. Integration tests: **data isolation between budgets**, owner vs member permissions, invitation flow, split-sum rules, money and month math
5. Playwright e2e for J1–J6 (including invite a partner) on phone and desktop projects
6. Screenshot baselines (after style approval) and axe scans
7. A map from acceptance criteria to tests
8. A manual release checklist: smoke test on the owner's phone, VoiceOver and TalkBack
9. Security regression tests as findings arrive; keep `make e2e` under about 10 minutes
