# ADR-0005: Money, currency and time
- Status: Accepted (owner, 2026-11-12)
- Date: 2026-11-12
- Areas affected: data, backend, frontend, tests

## Context
Rounding and timezone bugs are the most common causes of wrong totals in budgeting apps. The beta is US-only, so a single currency and locale are acceptable, but people travel and households can span timezones.

## Decision
- **Currency:** USD only. `budgets.currency` exists and is fixed to `'USD'` by a CHECK, so multi-currency can come later through an ADR without reshaping data.
- **Money representation:** integer **cents** everywhere: `bigint` in Postgres, JSON integers in the API, `number` (safe integers) in TypeScript. Limits: 1 to 100,000,000 cents ($1,000,000.00) per transaction or split; 0 to 100,000,000 per plan entry. No floats or decimal types in storage, arithmetic, or the client. The frontend parses typed input straight to cents (digits only, at most two decimal places) and formats with `Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'})`. The CSV export writes decimal dollars with two places, formatted from integers.
- **Rounding:** none needed in the MVP (no division, no FX). Any future division (e.g. "split evenly") must assign leftover cents explicitly in one shared function.
- **Transaction dates:** calendar `DATE` (`YYYY-MM-DD`) chosen by the user, with no time and no zone. Allowed range: 2000-01-01 to one year after today in the budget timezone.
- **Months:** `YYYY-MM` in the API; first-of-month `DATE` in the database.
- **"Today" and "current month":** computed in the **budget's IANA timezone** (set at creation from the creator's device, changeable by the owner). The server returns `today` and `currentMonth` on the Budget; the client uses the same timezone with `Intl` for the quick-add default date. Changing the timezone changes only what "today" means, never stored data.
- **Instants:** `timestamptz` in UTC in the database; RFC 3339 with `Z` and milliseconds in the API; displayed in the device's local zone.
- **Clock:** the backend reads time from an injectable clock so tests can freeze it (test-hooks.md).
- **Locale:** en-US only for formatting in the MVP.

## Alternatives considered
- **Decimal/numeric money:** works in Postgres but leaks into JS as strings or floats; integers are simpler and exact.
- **Timestamps for transactions:** forces a zone choice for every entry and creates off-by-one-day bugs at midnight and DST changes.
- **User timezone instead of budget timezone:** two members in different zones would disagree on "this month"; the budget is the shared frame.
- **Currency per transaction now:** no FX in scope; unused complexity.

## Consequences
- The month of a transaction never depends on a timezone, so summaries are stable.
- Tests: budget in `America/Los_Angeles` at 23:30 local on the last day of a month (UTC is already next month), DST transitions, year rollover, maximum amounts and sums.
- The JS safe-integer range is far above any reachable sum given the limits.
