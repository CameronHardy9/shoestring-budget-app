---
name: bug
description: Diagnose and fix a bug or incident through the team, test first. Invoke with /bug <symptom, error, or failing test>.
disable-model-invocation: true
---

Fix this problem: $ARGUMENTS

Act as tech lead. Wait for each report before the next step, and pass each agent
the evidence it needs, since agents don't see this conversation.

1. **Capture.** Collect the exact symptom: error text, stack trace, failing test, steps, environment, and when it started. Ask the owner for anything missing that matters.
2. **Production evidence** (sre): only if the problem is in a deployed environment. Gather logs, metrics, traces, and recent deploys and config changes. If users are affected now, have sre propose a mitigation (rollback, feature flag) for the owner to run before diagnosis continues.
3. **Diagnose** (debugger): root cause, evidence, reproduction, regression test spec, per-owner fix plan, blast radius. If confidence is low, run the debugger again with what it said it needs.
4. **Security check:** if the debugger flags security implications, run security-reviewer on the diagnosis now and treat its severity as the priority.
5. **Contract gap:** if the root cause is a missing or ambiguous contract, the architect fixes the contract first and the owner approves.
6. **Failing test first:** the owner of the test level the debugger chose writes the regression test (unit tests: the area owner; integration/e2e/visual: test-engineer) and confirms it fails for the right reason.
7. **Fix:** each owning agent applies its part of the fix plan, in the order given. The regression test must now pass.
8. **Data repair:** if bad data was written, data-engineer writes a repair migration or script; sre prepares the production steps for the owner.
9. **Verify:** run `make check`, `make e2e` and `make audit`. For security-relevant bugs, security-reviewer reviews the fix and adds it to FINDINGS.md as resolved.
10. **Prevent:** route the debugger's prevention item to its owner (a constraint, type, lint rule, alert, or runbook). For production incidents, sre drafts a blameless postmortem in docs/runbooks/incidents/.
11. **Hand back:** summarize root cause, fix, tests, any production steps for the owner to run, then commit on a `fix/` branch, push it, and open a PR (see Git in CLAUDE.md). Don't merge or deploy.
