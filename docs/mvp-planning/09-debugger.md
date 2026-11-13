# Meeting 9: debugger (making the app debuggable from day one)
Status: **meeting held 2026-11-12**

## Agent's agenda

### What needs to be built in from the start
| Item | Owner |
|---|---|
| Request ID across the whole request path: the frontend creates `X-Request-Id`; the backend accepts or creates it, logs it and returns it. Make `ErrorBody.requestId` required (it is optional today in api.openapi.yaml). | architect (contract), backend, frontend |
| Structured JSON logs carrying requestId, opaque userId, route, status and latency. Amounts, payees and account numbers are redacted. | backend; security-reviewer approves the redaction list |
| Seeded local data that comes out the same every run, with edge cases (month and year rollover, negative balances, zero and split transactions, DST boundary, multiple currencies if in scope). One command resets it. | data-engineer |
| Error tracking with source maps for frontend and backend. Builds tagged with the release or git SHA; source maps uploaded privately. | ci-engineer (upload), sre (tool and alerts) |
| "Copy diagnostics" in the app: build SHA, last requestId, user agent, viewport | frontend |
| A recipe for debugging on real phones: Safari Web Inspector and chrome://inspect against `make dev` over the LAN or a tunnel | ci-engineer (dev binding), sre (runbook) |
| Money as integer minor units; dates as ISO strings | architect (data-model.md), data-engineer |

### Decisions for the owner
1. **Error tracking tool?** (a) Sentry hosted free tier *(recommended)*, (b) self-hosted GlitchTip, (c) logs only
2. **What can error reports include?** (a) IDs only, (b) IDs plus non-financial context *(recommended)*, (c) full payloads
3. **Session replay?** (a) None *(recommended for the MVP)*, (b) masked replay on errors only
4. **Which phones count as supported?** (a) iOS Safari plus Android Chrome, latest two versions each *(recommended)*, (b) a wider list

### How to use the debugger during the MVP
- **Use /bug for:** failures you can reproduce, CI or test failures that persist after one retry, wrong totals or balances (always a bug), and production errors. Not for features or styling.
- **Evidence to capture from a phone:** the diagnostics paste or requestId, a screenshot or recording, the steps, expected vs actual numbers, device, OS and browser version, whether it's installed as a PWA or running in a tab, online or offline, and the time with timezone.

### Risks and open questions
- PII in logs: security-reviewer should review the redaction rules before the first endpoint ships.
- Whose timezone defines "the month"? This is an architect contract decision.
- Offline sync, if in scope, needs a client operation log from day one.
- Hosting is undecided, so log retention and where production evidence comes from are unknown (sre).

## Owner decisions (2026-11-12)
| Decision | Choice |
|---|---|
| Error tracking | **Sentry free tier** (consistent with the sre meeting), with PII scrubbing on |
| Error report contents | **IDs plus non-financial context**: request ID, opaque user ID, route, browser and build version. Never amounts, payees, memos or emails. |
| Session replay | **None** |
| Supported phones | iOS Safari and Android Chrome (architect NFR: iOS Safari 16.4+, current Android Chrome) |
| Timezone ruling | Months follow the budget's timezone (meeting 1) |

## Agreed tasks (approved as listed; built by the owning agents)
| Item | Owner |
|---|---|
| End-to-end `X-Request-Id`; make `ErrorBody.requestId` required | architect (contract), backend, frontend |
| Structured JSON logs with redaction | backend; security-reviewer approves the redaction list |
| Deterministic edge-case seed data with one-command reset | data-engineer |
| Sentry with private source maps, builds tagged with release or SHA | ci-engineer (upload), sre (project and alerts), frontend and backend (SDK) |
| "Copy diagnostics" in Settings | frontend |
| Recipe for debugging on real phones against `make dev` | ci-engineer (LAN binding), sre (runbook) |

The debugger itself is reactive. The owner calls `/bug` for reproducible failures, CI failures that persist after one retry, **any wrong total**, and production errors.
