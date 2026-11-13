# MVP planning meetings
The tech lead runs one planning meeting per specialist with the owner. Each file has
the agent's prepared agenda, then the owner's decisions and the agreed task list.

| # | Meeting | Status |
|---|---|---|
| 1 | [architect](01-architect.md): scope, stack, foundations | **held**; contracts written after all meetings |
| 2 | [data-engineer](02-data-engineer.md) | **held** |
| 3 | [backend-engineer](03-backend-engineer.md) | **held** |
| 4 | [frontend-engineer](04-frontend-engineer.md) | **held** |
| 5 | [test-engineer](05-test-engineer.md) | **held** |
| 6 | [ci-engineer](06-ci-engineer.md) | **held** |
| 7 | [sre](07-sre.md) | **held** |
| 8 | [security-reviewer](08-security-reviewer.md) | **held** |
| 9 | [debugger](09-debugger.md) | **held** |
| 10 | [Contract review decisions](10-contract-review-decisions.md): owner rulings on architect gaps, security OD-1 to OD-8, hosting | **decided** |

## Cross-cutting decisions (settled in meeting 1, applied to every later meeting)
Several agents raised the same questions. Each is decided once, here.

| Topic | Raised by | Decision |
|---|---|---|
| Who uses the MVP | architect, security, sre | Small invite-only beta (US only) |
| Budgeting method (limits vs envelope) | architect, data, backend | Monthly limits per category |
| Stack | architect, backend, frontend, ci | TypeScript: React+Vite, Fastify, PostgreSQL |
| PWA / offline | architect, frontend, data, backend | Installable PWA, online to save |
| Sign-in method and sessions | architect, backend, security | Email+password, 30-day cookie sessions; passkey/TOTP MFA **optional** (accepted risk) |
| Single user vs shared (tenancy) | architect, data, backend | Shared budgets in MVP; owner + equal members |
| Transaction input (manual / CSV / bank sync) | architect, data, backend, security | Manual only |
| Money, currency, timezone rules | architect, data, debugger | USD only, integer cents, budget timezone |
| Hosting and monthly budget | architect, sre | **$0, hard constraint** (no paid services; platform chosen in the sre meeting) |
| Export and account deletion | architect, data, security | CSV export + 30-day deletion grace |
| Domain | backend, sre | Owner's existing custom domain (shared): app on a subdomain, email from a sending subdomain. DNS changes are made by the owner. |
| App name | architect, frontend | **Shoestring** |

## Environment findings from prep
- The folder is not a git repository yet (CI and security diff reviews need one).
- There is no container runtime on this Mac (Docker, OrbStack or Colima is needed for `make dev`).
- The local Node is v20.10, which is end of life; Node 22 or 24 LTS is recommended.
- The Makefile targets are all stubs that `exit 1`.

## Next steps
**Owner prerequisites (only you can do these):**
1. Install OrbStack.
2. Upgrade Node to 24 LTS.
3. Run `git init` here and create a **public** GitHub repo. The ci-engineer will give you a checklist for branch protection and push protection.
4. Later, from sre's instructions: set hard billing caps on the host, and add the DNS records for `shoestring.<domain>` and the email sending subdomain.

**Build order (follows the /feature workflow):**
1. **architect** writes ARCHITECTURE.md, all the contracts and ADRs 0001–0007 from these decisions. **security-reviewer** reviews auth.md and data-model.md. **The owner approves the contract diff.**
2. **ci-engineer** (Makefile, compose, CI) and **sre** (hosting ADR, billing caps guide) can start as soon as the stack is fixed, in parallel with step 1.
3. **data-engineer**, then **backend-engineer**, then **frontend-engineer** (style proposal screenshots go to the owner early).
4. **test-engineer**, then **security-reviewer**, then **architect** integration review, looping until clean.

**Accepted risks (owner sign-off, 2026-11-12):** MFA optional for all users · backups can lose up to 24 hours of data · emulated phones in CI, with a manual check on the owner's phone before each release.
