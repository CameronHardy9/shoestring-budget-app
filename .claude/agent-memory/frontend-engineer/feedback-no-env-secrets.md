---
name: feedback-no-env-secrets
description: Do not read credentials from the local .env (e.g. SEED_USER_PASSWORD) to drive sign-in checks; the permission system denied it
metadata:
  type: feedback
---
Never read secrets out of `.env` (even local seed passwords) to run a manual signed-in check.

**Why:** on 2026-11-14 an attempt to pass SEED_USER_PASSWORD from .env into a browser script was denied by the permission classifier (treated as undermining oversight / secret handling).
**How to apply:** verify signed-out behaviour against the real backend without credentials; for signed-in flows use test-engineer's test hooks (`POST /api/_test/login` under make e2e) or ask the tech lead for an approved way. Mention the gap in the report instead of working around it.
