# Phase 2a: real screens against the local backend

Captured 2026-11-14 from the real app (Vite dev server + backend + Postgres, `make dev` with
`TEST_HOOKS=1`), driving a full journey in Chrome at 390 × 844 (2×) in light and dark. The
desktop shot is 1280 × 800. The data is what the journey typed, so every number came back
from the API.

| File                                            | Shows                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `01-signup-{light,dark}.png`                    | Sign-up from an emailed invite (`/signup#token=…`, token already removed from the URL)                              |
| `02-onboarding-{light,dark}.png`                | First budget: starter categories and monthly limits (one `POST /budgets`)                                           |
| `03-overview-empty-{light,dark}.png`            | New month, nothing recorded yet                                                                                     |
| `04-quick-add-{light,dark}.png`                 | Quick-add sheet: amount, category chips (most recent first), Save                                                   |
| `05-quick-add-split-{light,dark}.png`           | Split mode with "$6.40 left to assign" and "Put the rest on Household"                                              |
| `06-overview-{light,dark}.png`                  | Overview after five entries and a refund; overspending in words + stripes                                           |
| `07-overview-table-{light,dark}.png`            | The table alternative to the chart                                                                                  |
| `08-transactions-{light,dark}.png`              | Transactions grouped by day, category filter                                                                        |
| `09-edit-{light,dark}.png`                      | Editing a transaction (Delete + Save)                                                                               |
| `10-signin-error-{light,dark}.png`              | Sign-in after a wrong password (`INVALID_CREDENTIALS` copy)                                                         |
| `12-totp-setup-{light,dark}.png`                | Two-step setup: QR drawn on the device, key for manual entry                                                        |
| `13-totp-confirm-server-error-{light,dark}.png` | What a 500 looks like: input kept, a reference to quote. (Caused by a backend bug reported in the Phase 2a report.) |
| `15-overview-desktop-{light,dark}.png`          | Overview at desktop width with the side rail                                                                        |
