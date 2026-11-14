# Phase 2b: real screens against the local backend

Captured 2026-11-14 from the real app (Vite dev server + backend + Postgres, `make dev` with
`TEST_HOOKS=1` and `EMAIL_TRANSPORT=test`) at 390 × 844 (2×). The offline and update shots
come from the production build served with the production CSP.

| File                                | Shows                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `01-categories-{light,dark}.png`    | Categories and monthly limits for a month, copy last month                     |
| `02-invitations-light.png`          | A partner's pending budget invitation (accept / decline)                       |
| `03-members-owner-{light,dark}.png` | Owner view: members, Make owner / Remove, invite, invitation status            |
| `04-members-member-light.png`       | Member view after ownership was transferred: Leave                             |
| `05-deleted-budgets-light.png`      | A deleted budget, restorable for 30 days                                       |
| `06-sessions-light.png`             | Signed-in devices                                                              |
| `07-more-dark.png`                  | More: budgets, settings, theme switch (Automatic / Light / Dark), sign out     |
| `08-account-light.png`              | Account: name, email change, password, export, delete account                  |
| `09-recovery-codes-light.png`       | Recovery codes shown once after turning on two-step verification               |
| `10-mfa-challenge-light.png`        | Two-step verification at sign-in                                               |
| `11-pending-deletion-light.png`     | Signed in during the 30-day deletion grace period                              |
| `12-security-dark.png`              | Security with an authenticator app, a passkey and recovery codes               |
| `13-offline-light.png`              | Installed app opened offline: the shell loads from the service worker, no data |
| `14-update-banner-light.png`        | A new deploy is ready: "Reload"                                                |
