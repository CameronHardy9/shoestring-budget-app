# Runbooks
Owner: sre. One file per alert and per routine operation.

Each runbook has: **When to use** · **Steps** (exact commands) · **Verify** · **Back out**

| Runbook | Purpose |
|---|---|
| deploy.md | Deploy a release |
| rollback.md | Roll back to the previous release |
| restore.md | Restore the database from backup (last tested: <date>) |
| rotate-secret.md | Rotate a credential |

Targets: RPO <e.g. 1 hour> · RTO <e.g. 30 minutes>

incidents/ holds blameless postmortems: timeline, impact, root cause, what went well, what to change, owners.
