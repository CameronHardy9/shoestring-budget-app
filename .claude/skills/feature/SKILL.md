---
name: feature
description: Run a feature through the full specialist team, from contract to security review. Invoke with /feature <description>.
disable-model-invocation: true
---

Build this feature: $ARGUMENTS

Act as tech lead. Run these steps in order and wait for each specialist's report
before starting the next. Specialists don't see this conversation, so give each one
the acceptance criteria, the relevant contract sections, and the parts of earlier
reports that affect its work.

1. **Clarify.** Restate the feature and its acceptance criteria. If anything material is ambiguous, ask the owner before continuing.
2. **Design** (architect, design mode): update docs/contracts/ and docs/ARCHITECTURE.md, write an ADR for any real trade-off, and produce a per-agent work breakdown. Show the owner the contract diff and wait for approval.
3. **Data** (data-engineer): only if schema or data access changes.
4. **Backend** (backend-engineer).
5. **Frontend** (frontend-engineer).
6. **Tests** (test-engineer): contract, integration, e2e and visual coverage for every acceptance criterion.
7. **Security** (security-reviewer): review the full diff of this feature.
8. **CI and operations**: ci-engineer if dependencies, services, env vars or pipeline steps changed; sre if deployment, configuration, migrations during rollout, monitoring, alerts or runbooks are affected. A new endpoint or background job usually needs sre for observability and alerts.
9. **Integration review** (architect, integration-review mode).
10. **Loop.** Send every cross-area request, failing test, and Critical/High security finding back to its owning agent, then re-run the affected steps. If a failure's cause isn't obvious within one attempt, send it to the debugger before anyone changes more code. Repeat until clean.
11. **Hand back.** Run `make check`, `make e2e` and `make audit` yourself. Give the owner a short summary, test and audit results, open risks and decisions, then commit on a feature branch, push it, and open a PR (see Git in CLAUDE.md). Don't merge unless the owner asks.
