---
name: project-phase1-status
description: Frontend build status, owner decisions, device-only checks and UX rulings (MVP, hardening, lost-tap fixes, offline PR, lace loader, page loader session) as of 2026-11-24
metadata:
  type: project
---
Owner decisions 2026-11-14: direction approved; brand Indigo; self-hosted Inter; Save & new kept; CSP allows the two React Aria sha256 hashes; quick-add has NO pre-selected category (3 taps).

All 15 frontend MVP tasks delivered on feat/frontend (uncommitted by me; tech lead commits). The throttle-refund backend bug was fixed in PR #6 (data-engineer) and MFA sign-in (TOTP, recovery code, passkey), re-auth with a second factor and TOTP confirm were verified against the real backend afterwards.

**Why:** owner paces work with checkpoints and reviews screenshots.
**How to apply:** remaining risk is device-only: iOS keypad auto-open on sheet open, keyboard inset, VoiceOver/TalkBack pass, PWA install on iPhone/Android, passkeys on real devices. Initial JS ~136 KB of 150: new screens must stay lazy.

Pre-launch hardening (2026-11-16, fix/pre-launch-hardening): F-51 (honest sign-out), F-52 (storage lint ban), F-54 (resume state bound to user ID) done, plus pending-deletion export, delayed revokeObjectURL, shared re-auth prompt, reset MFA_REQUIRED → MFA step. Still open by design: "Reload" banner reloads every tab (needs an owner decision), F-50 (with the Sentry PR), lastBudgetId in localStorage is not user-bound (ADR-0002 accepted; Home only uses it if it is in the new user's list).

Lost-tap follow-up (2026-11-16, fix/loading-tap-targets, owner ruling round 6): chose "gate controls below a variable-height loading region" over sized skeletons (no persisted cache under ADR-0002, so a "cached count" never exists when the skeleton shows). Quick-add sheet now opens before the budget loads. Rule written into frontend/CLAUDE.md. Round 7 owner rulings (2026-11-16): chip order frozen per sheet session (new categories go last; just-used leads on next open) and BudgetLayout prefetches the 50-item recent list (same key as the sheet).


Offline + F-62 web (2026-11-17, fix/offline-and-f62, owner rulings round 7/8): mutations `networkMode: "always"` (fail fast offline, no exceptions); every data screen's pending slot is `PendingSlot` (incl. Home, which wasn't on the owner's list). F-62 (b) residual: a line-break-exact message cut can't be detected; flagged to the tech lead for security-reviewer. Not done: an offline note for a paused "Load more" (Transactions) — the button just does nothing visible until reconnect.

Lace loader (2026-11-23, "Loader D") was replaced on 2026-11-24 (feat/ivory-navy-recolour) by **Loader E** (ivory tile + border, tongue with navy lines making a "$", dark-edged white lace, grey tip leading at dashoffset 0.015) and the **ivory & navy recolour** (dark = black canvas + ivory brand). Owner rulings: one green (success = + button forest `#2e6a4f`; dark success lightened to `#6fc79a` for text contrast; `--ss-fab` dark darkened to `#3c8461` (4.50:1 with white) so the desktop rail "Add transaction" button can be green too); loader **centred in the viewport at 96 px**.
**Why:** owner reviewed mockups on the design canvas and chose these.
**How to apply:** `LoadingState` default = fixed, centred, pointer-events-none, z-20 (under nav z-30 / sheet z-40 / dialogs z-50), no space reserved; `placement="inline"` (56 px, rows min-height) only inside the quick-add sheet and Overview's Recent (below loaded content). Superseded 2026-11-24 (fix/loader-full-cycles, owner rulings): viewport loads form one **page loader session** (`components/page-loader.ts` + `<PageLoader>`): 150 ms grace, opaque cover + inert mains, reveal only at a 3.2 s cycle boundary (reduced motion: at once), chain window 100 ms, Offline/ErrorState interrupt, inline loaders untouched. React's 300 ms Suspense reveal throttle makes every un-preloaded lazy screen pass grace and hold a full cycle (~3.4 s); owner chose (a): `TAB_SCREENS` preloaded at idle after the first session ends, once signed in (`app/preload.ts`). Owner also accepted: cover hides page chrome; Overview month switch holds a cycle (no placeholderData). Both add buttons use variant="fab" (owner ruling 2026-11-24). Favicon/app icons still indigo: logo on hold.
