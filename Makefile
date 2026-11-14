# Canonical commands. Every agent and CI runs exactly these targets.
# The logic lives in .github/scripts/*.sh (bash, strict mode) so it works with
# the GNU Make 3.81 that ships with macOS. Requires Node 24 (nvm use), pnpm via
# corepack, and Docker (OrbStack). Run `make help` for the phone-testing recipe.
SCRIPTS := .github/scripts

.DEFAULT_GOAL := help
.PHONY: help setup dev dev-lan dev-down dev-logs dev-reset \
        lint typecheck test check e2e audit image image-smoke

help: ## Show targets and the phone-testing recipe
	@echo "Shoestring: canonical commands"
	@echo ""
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "} {printf "  make %-12s %s\n", $$1, $$2}'
	@echo ""
	@echo "Test on a real phone over the LAN (phone and Mac on the same Wi-Fi):"
	@echo "  1. make dev LAN=1   (or make dev-lan) prints  Phone  http://<mac-ip>:5173"
	@echo "     Only the frontend dev server opens to the LAN; Postgres and the API stay on"
	@echo "     127.0.0.1. Allow incoming connections if macOS asks (OrbStack)."
	@echo "  2. Open that URL on the phone. APP_ORIGIN is set to it, so CSRF Origin checks pass."
	@echo "     Over plain http on a LAN IP the browser is not a secure context: service"
	@echo "     worker (PWA install) and passkeys are unavailable there. Test those on"
	@echo "     localhost or the deployed https site."
	@echo "  3. iPhone + Safari Web Inspector: on the iPhone, Settings > Apps > Safari >"
	@echo "     Advanced > Web Inspector on. Connect by USB (or pair over Wi-Fi in Finder),"
	@echo "     then on the Mac: Safari > Settings > Advanced > Show features for web"
	@echo "     developers, and use Develop > <your iPhone> > <the page>."
	@echo "  4. Android + Chrome: Settings > About phone > tap Build number 7 times, then"
	@echo "     Developer options > USB debugging on. Connect by USB, open chrome://inspect"
	@echo "     on the Mac and click inspect under the page. With port forwarding"
	@echo "     (5173 -> localhost:5173) and plain make dev, the phone can open"
	@echo "     http://localhost:5173, a secure context where service worker and passkeys work."
	@echo "  5. Stop exposing the dev server when done: make dev (without LAN=1) or make dev-down."

setup: ## Install dependencies, Playwright browsers once tests/ needs them, and a random-credential .env
	@bash $(SCRIPTS)/setup.sh

dev: ## Start the whole stack in containers and wait until healthy (LAN=1 for phones)
	@bash $(SCRIPTS)/dev.sh

dev-lan: ## Same as make dev LAN=1
	@LAN=1 bash $(SCRIPTS)/dev.sh

dev-down: ## Stop the dev stack (keeps the database)
	@bash $(SCRIPTS)/dev-ctl.sh down

dev-logs: ## Follow dev stack logs
	@bash $(SCRIPTS)/dev-ctl.sh logs

dev-reset: ## Stop the dev stack and delete the dev database (re-migrated and re-seeded on next make dev)
	@bash $(SCRIPTS)/dev-ctl.sh reset

lint: ## Lint every package, plus workflows, scripts and CI config
	@bash $(SCRIPTS)/lint.sh

typecheck: ## Typecheck every package
	@bash $(SCRIPTS)/typecheck.sh

test: ## Unit tests in every package (with a throwaway Postgres once db/ exists)
	@bash $(SCRIPTS)/test.sh

check: lint typecheck test ## lint + typecheck + unit tests (must pass before "done")

e2e: ## Integration, contract, end-to-end and visual tests against a throwaway stack
	@bash $(SCRIPTS)/e2e.sh

audit: ## Secret scan (gitleaks) + SAST (Semgrep) + dependencies (osv-scanner) + workflows (zizmor)
	@bash $(SCRIPTS)/audit.sh

image: ## Build the production image (skips until backend/ exists; API-only until frontend/ exists)
	@bash $(SCRIPTS)/image.sh

image-smoke: ## Run the production image against a throwaway Postgres and probe it (ADR-0009)
	@bash $(SCRIPTS)/image-smoke.sh
