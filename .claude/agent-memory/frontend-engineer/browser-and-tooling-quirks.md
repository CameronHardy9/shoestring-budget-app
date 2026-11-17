---
name: browser-and-tooling-quirks
description: Non-obvious browser/tooling behaviours hit while building the Shoestring SPA (React Aria CSP styles, insecure-context crypto, Tailwind v4 ordering, Vite/Playwright/jsdom gotchas)
metadata:
  type: reference
---
Verified 2026-11-14 (React Aria 3.53 / RAC 1.22, Vite 8.3, Tailwind 4.3, playwright-core 1.65):

- **React Aria injects `<style>` elements** (usePress on every pressable; usePreventScroll on open modals, iOS WebKit only). Blocked by `style-src 'self'`. Fix = CSP sha256 hashes (`frontend/src/security/csp.ts`, guarded by `scripts/csp-style-hashes.test.ts`). React Aria also reads a nonce from `<meta name="csp-nonce">` if ever needed. ARCHITECTURE's "React Aria doesn't inject styles" assumption was wrong.
- To trigger the iOS path in Chrome emulation you must override both `navigator.platform` AND `navigator.userAgentData` (React Aria prefers userAgentData.platform).
- `crypto.randomUUID` is missing on plain-http LAN origins (make dev LAN=1): use getRandomValues.
- **Tailwind v4 orders utilities by property, not class-attribute order**: a caller's `px-3`/`text-sm`/`rounded-full` does not override a component's base class. Use variant props. `@source not "../preview"` in the shared CSS also starves a preview that imports the same CSS (re-adding `@source` does not win).
- jsdom's `DOMException` is not `instanceof Error`; detect aborts by `name === "AbortError"`.
- Vite dev reloads the page on the first dynamic import of a not-yet-optimised dep: warm up before page.evaluate.
- Local Playwright browser cache (r1208) does not match playwright-core 1.65 (r1254): screenshots use `channel: "chrome"` (installed Chrome), no download.
- Under jsdom, `fileURLToPath(new URL(x, import.meta.url))` fails: Node-side tests need `// @vitest-environment node`.
- Node's fetch/Request rejects relative URLs: the API client builds its base from `window.location.origin` so tests can stub global fetch.
- A React Aria Modal sets aria-hidden on everything outside it, toasts' live region included: status shown while a sheet is open needs a live region inside the dialog.
- `getByRole("radio")` on RAC chips resolves the visually hidden input; a forced Playwright click on it can hit the scrim and dismiss the sheet. Click the label text.
- RAC Button `isPending` uses the live announcer, which leaves role="img" nodes axe flags; exclude `[data-live-announcer]` in axe runs.
- RAC 1.22 deprecates `Radio`/`Checkbox` (use RadioField+RadioButton, CheckboxField+CheckboxButton); eslint no-deprecated catches it.
- Postgres evaluates CHECK constraints on the proposed row BEFORE ON CONFLICT: `INSERT … VALUES (count=-1) ON CONFLICT DO UPDATE` always fails a `count >= 0` check (found in the backend throttle refund, 2026-11-14).
- Service worker cache lookups must use `ignoreVary` (match by path): crossorigin module requests carry Origin, the precache didn't, and a Vary header made every lookup miss (blank page offline).
- `/api/_test/emails` only works with `EMAIL_TRANSPORT=test` (make dev defaults to console); passkeys work headless with the CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator`, ctap2/internal) on localhost.
- **React 19 `lazy` always suspends on first render even if the module is already imported** (the factory promise settles a tick later), then holds the fallback ≥300 ms (FALLBACK_THROTTLE_MS). Preloading modules alone does NOT make route tests deterministic; measured render→heading 360 ms vs 50 ms. Fix (2026-11-16): `lazyScreen()` + `.preload()` renders the loaded component directly; tests that render `<App />` use `beforeAll(preloadScreens)`. Flaky `findBy` under load in App/a11y tests came from this.
- Two concurrent `vitest --coverage` runs in one package clash on `coverage/.tmp`: give one `--coverage.reportsDirectory=…` (with pnpm, no `--` before it).
- Sign-up limit is 10/h/IP and refused attempts count: repeated local journeys lock it; use `/api/_test/clock` briefly (then `{now:null}`) or reset.
- jsdom can't do full-document navigation (`location.replace` is "not implemented" and can't be spied: non-configurable). auth.tsx routes it through the exported `hardNavigation.replace` seam; tests `vi.spyOn(hardNavigation, "replace")` (2026-11-16).
- Lint-rule fixture tests: `new ESLint({ cwd, overrideConfig: { languageOptions: { parserOptions: { project: null } } }, ruleFilter })` + `lintText(code, { filePath })` runs the real flat config on virtual files without a tsconfig program (type-aware rules filtered out). See scripts/eslint-storage-ban.test.ts.
- ESLint `no-restricted-properties` with only `property:` (no `object:`) bans it on ANY object, incl. computed `w["x"]`, aliases and `const { x } = window` destructuring; `no-restricted-globals` only sees bare identifiers.
- **Don't edit anything under frontend/ while `make e2e` runs** (not even CLAUDE.md): the stack serves the live tree through Vite dev and Tailwind's source scan triggers HMR. But the J4 "socket hang up" (2026-11-16) recurred with NO edits: it fails after the test body, in the Node teardown (`emails()` hook), most likely a keep-alive race (tests/support/http.ts `keepAlive: true` agent vs the edge's default 5 s server keepAliveTimeout; J4 idles ~5-6 s on the Node side). Not a frontend bug; owned by test-engineer/ci-engineer. `make e2e` skips the visual stage when the e2e stage fails.
