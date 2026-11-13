# Canonical commands. Every agent and CI uses exactly these targets.
# ci-engineer replaces each TODO with the real command for the chosen stack.
.PHONY: setup dev lint typecheck test check e2e audit

setup: ; @echo "TODO(ci-engineer): install all dependencies"; exit 1
dev: ; @echo "TODO(ci-engineer): start the full stack locally (docker compose)"; exit 1
lint: ; @echo "TODO(ci-engineer): lint frontend, backend, db, tests"; exit 1
typecheck: ; @echo "TODO(ci-engineer): typecheck all areas"; exit 1
test: ; @echo "TODO(ci-engineer): run all unit tests"; exit 1
check: lint typecheck test
e2e: ; @echo "TODO(ci-engineer): run contract, integration, e2e and visual tests"; exit 1
audit: ; @echo "TODO(ci-engineer): dependency audit + secret scan + static analysis"; exit 1
