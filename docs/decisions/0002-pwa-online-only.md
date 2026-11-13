# ADR-0002: Installable PWA, online to save
- Status: Accepted (owner, 2026-11-12)
- Date: 2026-11-12
- Areas affected: frontend, backend, data, tests, sre, security

## Context
Users add transactions on their phones, often on poor connections (in a shop). Native apps are out of scope. Offline-first sync would roughly double the data-layer work and puts financial data on shared phones. The owner chose an installable PWA that needs a connection to save.

## Decision
- **Installable PWA:** web app manifest, icons, a service worker that **precaches only the app shell** (HTML, JS, CSS, self-hosted fonts, icons). `/api/*` is network-only and never cached; API responses carry `Cache-Control: no-store`.
- **No financial data on the device:** no localStorage, IndexedDB or Cache Storage for API data; in-memory query cache only, cleared at sign-out. localStorage may hold the theme preference and the last-used budget ID.
- **Online to save, safe to retry:**
  - `POST /budgets/{id}/transactions` and `POST /budgets` require an `Idempotency-Key` (UUID per user intent, reused on every retry, kept 24 h). Same key + same body replays the original result (201, `Idempotent-Replayed: true`); same key + different body is 422 `IDEMPOTENCY_KEY_REUSED`.
  - Edits carry the row `version`; a stale version is 409 `VERSION_CONFLICT`. The client refetches and shows the difference; it never overwrites silently.
  - Lists use opaque cursors (`date DESC, id DESC`).
  - When offline or on failure, the quick-add sheet keeps everything typed in memory and offers retry. There is no background queue.
- **Updates:** the service worker checks for a new version on each navigation and shows a "reload to update" prompt. Within the MVP, API changes are additive so a slightly stale shell keeps working.
- **iOS specifics:** the installed PWA has its own cookie jar (the user signs in again inside it); Safari 16.4+ is the floor.

## Alternatives considered
- **Responsive site only:** no home-screen install, slower repeat loads.
- **Read-only offline cache:** puts financial data on shared phones; owner and security rejected it.
- **Offline-first with queued sync:** about twice the data and backend work, conflict resolution UX, and data on device.

## Consequences
- Simple consistency model: the server is always the source of truth.
- Backend: idempotency table and replay logic; version checks on every update. Data: `version` columns, `idempotency_keys`.
- Frontend: generate the Idempotency-Key when the sheet opens and reuse it on retry; new key after a successful save ("Save & add another").
- Tests: retry/replay, key reuse, and conflict cases in contract and e2e tests; verify no `/api` responses are in Cache Storage.
- Revisit if users report losing entries while offline (a small encrypted pending queue would need its own ADR).
