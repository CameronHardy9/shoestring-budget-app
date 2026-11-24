---
name: diagnostic-preview-harness
description: How to repro frontend focus/layout bugs without backend - Vite preview.html + Playwright WebKit from tests/node_modules
metadata:
  type: reference
---

Backend-free repro technique that worked (2026-11-24):
- `frontend/node_modules/.bin/vite --port 5299 --strictPort` (pnpm is not on PATH in agent shells; `source ~/.nvm/nvm.sh && nvm use 24` first). Open `/preview.html?screen=quick-add` or `quick-add-split`: real Sheet/ChipGroup/AmountField with mock data.
- Run a scratch .mjs that does `createRequire(".../tests/package.json")` then `require("@playwright/test")`, using webkit with `devices["iPhone 13"]`. `locator.tap()` produces pointerType "touch".
- Log `focusin`/`focusout` (capture) with `relatedTarget`. The `addInitScript` probes can try out fixes without editing app code.
- Chips' RAC class names are overridden, so locate them with `label:has(input[type=radio])`.
- Kill the vite PID afterwards: `pkill -f` from a subshell launch may miss it, so check with `lsof -iTCP:5299`.

Related: [[ios-keyboard-focus-theft]]
