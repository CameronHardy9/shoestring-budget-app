# Meeting 1: architect (product scope and foundations)
Status: **meeting held 2026-11-12. Contracts and ADRs will be written after all 9 meetings.**

## Agent's agenda

### Proposed MVP journeys
1. **J1 Onboard on a phone:** sign up, create a first budget from starter categories, set monthly amounts, land on the dashboard
2. **J2 Quick-add a transaction in under 10 seconds:** amount, category, date (today by default), optional note, one-handed. This is the core loop.
3. **J3 "How am I doing this month?":** planned, spent and remaining per category, with overspending highlighted
4. **J4 Review and fix:** the month's transactions filtered by category; edit and delete
5. **J5 Start next month:** copy last month's plan and adjust it

**Deferred:** bank sync, CSV import (first thing after the MVP), multi-currency, shared households (the model allows for them later), native apps, offline writes and sync, recurring transactions, charts beyond the monthly summary, goals, notifications, receipts.

### Decisions for the owner
- **D1. Who is it for?** (a) just you, invite-only *(recommended, but built multi-user)*, (b) a public beta with open sign-up
- **D2. Budgeting method:** (a) monthly limits per category *(recommended)*, (b) zero-based/envelope (YNAB-style rollover), (c) both. This needs deciding now because it shapes the core entities.
- **D3. Stack:** TypeScript throughout: React + Vite SPA, Fastify, PostgreSQL with SQL migrations, an API client generated from OpenAPI *(recommended)*. Alternatives: SvelteKit or Next.js; FastAPI; SQLite.
- **D4. Mobile approach:** (a) responsive site, (b) installable PWA, online to save *(recommended)*, (c) offline-first PWA with sync
- **D5. Sign-in:** (a) email + password with server-side sessions, a secure cookie and a 30-day sliding expiry *(recommended; passkeys later)*, (b) magic links, (c) passkeys, (d) a managed service (Auth0, Clerk or Supabase)
- **D6. Tenancy:** (a) data owned by a user, (b) data owned by a Budget with a membership table and one member in the MVP *(recommended)*
- **D7. Getting transactions in:** manual only *(recommended)*, plus CSV import, or plus bank sync (Plaid)
- **D8. Money and time rules:** integer cents; one currency per budget, fixed when it's created; month boundaries follow the budget's timezone *(recommended)*
- **D9. Hosting:** a managed platform (Fly, Render or Railway) with managed Postgres and backups *(recommended)*, a self-managed server, or serverless

### Draft task list
- ARCHITECTURE.md: purpose, journeys J1–J5, system diagram, NFRs (load under 2.5 s on a mid-range Android phone over 4G, a JS bundle budget, WCAG 2.2 AA with 44px touch targets, iOS Safari 16.4+ and current Android Chrome, backup targets)
- data-model.md: User, Session, Budget, BudgetMember, Category, MonthlyPlan, Transaction, with invariants and PII marked
- auth.md: cookie sessions, CSRF, rate limits, a deny-by-default matrix based on budget membership
- api.openapi.yaml: auth, budgets, categories, monthly plans, transactions (cursor pagination, idempotency keys, versioned edits that return 409 on conflict), monthly summary
- errors.md: domain codes (CATEGORY_ARCHIVED, IDEMPOTENCY_KEY_REUSED, and so on)
- ADRs 0001–0007: stack, PWA, auth, budgeting method, money/currency/time, tenancy, hosting

### Dependencies
D3 blocks everyone · D9 blocks sre and ci deploy work · D2, D6 and D8 block data and backend · D5 blocks backend, frontend sessions, security and tests · D4 blocks frontend, sre caching and mobile tests · contract approval blocks backend and frontend

### Risks and open questions
- Write the threat model before any code exists
- Weak signal while shopping: is a small offline "pending" queue in scope?
- Scope creep toward bank sync and charts
- Still open: the app name, whether export and account deletion are in the MVP (recommended: CSV export plus deletion), the hosting budget
- The CLAUDE.md placeholders need filling (tech lead)

## Owner decisions (2026-11-12)
| # | Decision | Notes |
|---|---|---|
| D1 Audience | **Small invite-only beta** | No open sign-up; email verification needed. MFA is **optional** (decided in meeting 8). |
| D2 Budgeting method | **Monthly limits per category** | No envelope or rollover in the MVP |
| D3 Stack | **TypeScript end to end**: React + Vite SPA, Node + Fastify, PostgreSQL, API client generated from OpenAPI | |
| D4 Mobile | **Installable PWA, online to save** | Idempotency keys make retries safe; no offline queue |
| D5 Sign-in | **Email + password** (argon2id, server-side cookie sessions with 30-day sliding expiry), **passkeys / TOTP as MFA** | Needs a transactional email provider |
| D6 Sharing | **Shared budgets in the MVP** | Changed from the architect's recommendation: invites and membership are in scope |
| D6b Roles | **Owner + equal members** | Members can view and edit transactions and limits. Only the owner can invite or remove members and rename or delete the budget. |
| D7 Input | **Manual entry only** | CSV import is first after the MVP |
| D8 Currency | **USD only**, integer cents | Month boundaries follow the budget's timezone (architect default, not separately asked) |
| D9 Hosting budget | **$0, a hard constraint.** The only cost is the owner's existing Claude subscription. | No paid hosting, database, domain, email, monitoring, test or CI services. Free tiers usually lack PITR, so sre designs free backups. Same-origin serving is probably needed for cookies on a platform subdomain. |
| Export and deletion | **CSV export + account deletion with a 30-day grace period**; backups expire within 35 days | |
| Region | **US only** | US hosting region |
| App name | **Shoestring** | |

## Agreed tasks
Approved as proposed, with shared budgets added:
- ARCHITECTURE.md: journeys J1–J5 plus **J6: invite a partner, they accept, both see the same budget**. System diagram; NFRs (load under 2.5 s on a mid-range Android phone over 4G, WCAG 2.2 AA with 44px targets, iOS Safari 16.4+ and Android Chrome); the $0 cost constraint.
- data-model.md: User, Session, Passkey/MFA, Budget, BudgetMember (owner or member), Invitation, Category, MonthlyPlan, Transaction (plus whatever later meetings add), with PII marked
- auth.md: cookie sessions, CSRF, MFA and re-authentication for sensitive actions, invite-only registration, a permission matrix for owner, member and non-member
- api.openapi.yaml: auth, invitations and members, budgets, categories, monthly plans, transactions (idempotency keys, 409 on edit conflicts), monthly summary, export, account deletion
- errors.md: domain codes plus per-field validation details
- ADRs 0001–0007: stack, PWA, auth and MFA, budgeting method, money and time, shared-budget tenancy, hosting at $0
- Tech lead: fill in the CLAUDE.md placeholders (name, description, stack)
