---
name: owner-constraints
description: Shoestring owner's binding ops constraints from the 2026-11-12 sre meeting ($0 hard, card only with caps, no staging, RPO 24h, alerts by email + push)
metadata:
  type: user
---

The owner is a solo developer who runs every production command themselves. Ops decisions (2026-11-12, docs/mvp-planning/07-sre.md):
- $0/month is a hard limit. A card on file is acceptable only with hard caps that the owner applies. Flag any residual overshoot risk honestly rather than hiding it.
- Cold start of a few seconds at most. Under 10 US beta users. Local + production only, no staging.
- RPO 24h (accepted risk), backups encrypted and expiring within 35 days, restore drill before launch.
- Alerts by email and phone push. Public GitHub repo (logs and artifacts are public).

**How to apply:** Give the owner exact copy-paste commands with Verify and Back out steps. Mark anything unconfirmed as "verify". Never propose paid services without an ADR.
Related: [[project-hosting-proposal]]
