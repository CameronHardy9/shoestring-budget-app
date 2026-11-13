# Pinned container images for the tools that make lint, make audit and make e2e run.
# This file is NOT built. It is the single place these versions live, so that
# Dependabot (docker ecosystem) can update them; .github/scripts/lib.sh reads the
# image reference for each stage name below. Keep tag and digest together.

# Workflow linter (make lint)
FROM rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667 AS actionlint

# Secret scanning of the working tree and full git history (make audit)
FROM ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f AS gitleaks

# Static analysis, Semgrep Community Edition (make audit)
FROM semgrep/semgrep:1.185.0@sha256:67518c174185a2043fdbed16c70631b79209499b3671178e7194379b48295a0d AS semgrep

# Dependency vulnerabilities from pnpm-lock.yaml (make audit)
FROM ghcr.io/google/osv-scanner:v2.7.1@sha256:a70ffffc2bfd33482953e5d6b64c6fcdb30239717a07b0f0d3ab2859ce3e4cde AS osv-scanner

# GitHub Actions security linter (make audit)
FROM ghcr.io/zizmorcore/zizmor:1.32.0@sha256:3014cc8f68f663935f69b3c3e0e41f5ce102b268d97db13db0f62208747f860d AS zizmor

# Visual screenshots (make e2e). The version MUST equal @playwright/test in
# tests/package.json; make e2e fails with a clear message if they differ.
FROM mcr.microsoft.com/playwright:v1.65.0-noble@sha256:9beb546099e11f52d62e505537914870e01a67e0e6b00ae41da4775324e73dbe AS playwright
