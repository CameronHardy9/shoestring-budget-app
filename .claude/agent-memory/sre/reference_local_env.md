---
name: reference-local-env
description: What works from the owner's Mac for sre — gcloud already authenticated to prod (read-only queries OK), API-enable prompts, and running make check without corepack enable
metadata:
  type: reference
---

Observed 2026-11-23:
- `gcloud` (SDK 594) is installed and logged in as the owner, `billing/quota_project = shoestring-prod-ssba`. Read-only `describe`/`list`/`logging read` against prod work from the agent shell (the tech lead allowed read-only use that day). Always pass `</dev/null`, because gcloud may prompt "enable API and retry? (y/N)". Without a TTY it answers N, which is what we want; never answer y.
- The gcloud SDK source is at /opt/homebrew/share/google-cloud-sdk/lib. It helps to read a command's surface YAML to learn the real flag semantics and update masks.
- `make check` needs Node 24 (`source ~/.nvm/nvm.sh; nvm use 24`) and `pnpm` on PATH. pnpm comes only through corepack. Don't run `corepack enable`, which writes into the nvm install. Put a scratchpad shim `pnpm` → `exec corepack pnpm "$@"` first on PATH instead.
- `jq` is 1.7.1 (apple); `shellcheck` is not installed.

Related: [[project-hosting-proposal]], [[owner-constraints]]
