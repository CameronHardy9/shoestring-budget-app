# Meeting 4: frontend-engineer
Status: **meeting held 2026-11-12**

## Agent's agenda

### Proposed MVP screens and mobile UX
- **Navigation:** a bottom tab bar (Overview, Transactions, Budgets, More) with a central "+". It becomes a side rail at about 1024px or wider. Respects safe areas; works from 320px wide.
- **Sign in / sign up**, then onboarding: pick starter categories and set monthly budgets.
- **Overview:** spent vs budget this month, the amount left, top categories, and the 5 most recent transactions.
- **Transactions:** a list grouped by day, filtered by month and category, with edit and delete. Swipe actions also have a menu equivalent.
- **Add transaction (3 taps, under 10 seconds):** "+" opens a bottom sheet.
  - Amount first, with the numeric keypad open.
  - An expense/income toggle and category chips, most recent first.
  - The date defaults to today; the note is optional.
  - "Save" and "Save & add another".
  - Honest saving states; on failure, nothing typed is lost.
- **Budgets:** progress bars per category, always with a number, so colour is never the only signal.
- **Charts:** horizontal bars by category and a monthly trend, each with a table view for screen readers.
- **More:** accounts, categories, settings, sign out.

### Decisions for the owner
1. **Framework:** (a) React + TypeScript + Vite SPA *(recommended)*, (b) Next.js, (c) SvelteKit
2. **Install and offline:** (a) a normal website, (b) installable PWA with a cached shell *(recommended)*, (c) offline-first with queued sync
3. **Components:** (a) Radix or React Aria primitives plus our own tokens *(recommended)*, (b) MUI or Mantine, (c) fully custom
4. **Styling:** (a) Tailwind with CSS-variable tokens *(recommended)*, (b) CSS Modules, (c) CSS-in-JS (avoid; it conflicts with a strict CSP)
5. **Dark mode:** (a) none, (b) follow the system setting *(recommended now)*, (c) system setting plus a manual switch
6. **Charts:** (a) our own simple SVG *(recommended)*, (b) Recharts, (c) visx, (d) Chart.js
7. **Look and feel:** (a) the owner supplies designs, (b) follow a reference app (YNAB, Monarch, Copilot, Goodbudget), (c) the engineer proposes a clean, neutral system. Also needed: app name, brand colour, logo.
8. **Device support:** the latest 2 versions of iOS Safari and Android Chrome, plus current desktop browsers *(recommended)*

### Draft task list
1. Scaffold: strict TypeScript, lint and format, Vitest + Testing Library + axe, wired into `make check`
2. API client generated from OpenAPI; a wrapper handling cookies, CSRF and error-code mapping
3. Light and dark tokens; core components (Button, TextField, MoneyInput, ChipGroup, Sheet, Toast, Skeleton, EmptyState, ErrorState, ProgressBar)
4. App shell: responsive navigation, routing, auth guard, one loading/empty/error pattern
5. Auth and onboarding
6. Add, edit and delete transactions
7. Transaction list with filters and paging
8. Category and budget management
9. Overview and accessible charts
10. Money and date formatting (integer cents, locale-aware)
11. PWA manifest and icons
12. Accessibility and performance pass (VoiceOver, TalkBack, keyboard), stable test IDs
13. frontend/CLAUDE.md conventions

### Dependencies
- **architect:** endpoints and a summary endpoint, pagination, money format, which timezone defines "the month", auth, journeys, budgets. Request: per-field details on `VALIDATION_FAILED`.
- **backend:** duplicate-safe creates (idempotency); stable sort order.
- **ci:** Node version, a client-generation step.
- **tests:** test IDs; snapshot widths 375, 768 and 1280.
- **security:** CSP, self-hosted fonts, client storage rules.
- **sre:** static hosting, cache headers, service-worker updates.

### Risks and open questions
- Confirm what's out of scope (bank sync, recurring, CSV, multi-currency, sharing)
- Financial data cached on shared phones
- Money rounding and timezones
- iOS Safari quirks: zoom on inputs under 16px, the keyboard covering sheets, `100vh`, storage for installed apps being cleared
- Without designs, the visuals may need rework, so delay snapshot tests

## Owner decisions (2026-11-12)
Already settled: React + TypeScript + Vite SPA · **installable PWA, online to save** · app name **Shoestring** · shared budgets (owner + equal members) · USD only · no accounts or recurring transactions · **split transactions included** (needs a compact "split" option in the quick-add sheet) · MFA with passkeys and TOTP · $0 cost (self-hosted fonts, no paid services).

| Decision | Choice |
|---|---|
| UI toolkit | **React Aria or Radix primitives + Tailwind** with CSS-variable design tokens |
| Dark mode | **Follow the phone's setting, plus a manual switch** in settings |
| Visual direction | **The engineer proposes a clean, neutral style** with a brand colour. The owner reviews screenshots before visual baselines are locked. |
| Charts | Agent default: our own simple SVG charts, each with a table view for screen readers |

## Agreed tasks (approved as listed)
1. Scaffold: strict TypeScript, lint, Vitest + Testing Library + axe, wired into `make check`
2. Generated API client; a wrapper for cookies, CSRF, error-code mapping and per-field errors
3. **Style proposal**: tokens (light and dark), brand colour, screenshots for owner approval
4. Core components (MoneyInput, category chips, sheet, toast, and so on)
5. App shell: bottom tabs that become a side rail on desktop, auth guard, one loading/empty/error pattern
6. Auth screens: invite sign-up, login, verification, MFA setup (passkey or TOTP, recovery codes), password reset
7. Quick-add sheet (3 taps, under 10 s) plus a **split editor** showing the amount left to assign; edit and delete
8. Transaction list grouped by day, with month and category filters and paging
9. Category and monthly-limit management, including "copy last month"
10. Overview: planned, spent and remaining, with accessible SVG charts
11. Budget members: invite, accept, list, remove (owner only)
12. Settings: theme switch, CSV export, delete account (with re-authentication), sign out
13. PWA manifest, icons and app-shell caching; no financial data cached on the device
14. Accessibility and performance pass (VoiceOver, TalkBack, keyboard), stable test IDs
15. frontend/CLAUDE.md
