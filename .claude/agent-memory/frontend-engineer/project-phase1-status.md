---
name: project-phase1-status
description: Frontend build status, owner decisions, device-only checks and UX rulings (MVP, hardening, lost-tap fixes) as of 2026-11-16
metadata:
  type: project
---
Owner decisions 2026-11-14: direction approved; brand Indigo; self-hosted Inter; Save & new kept; CSP allows the two React Aria sha256 hashes; quick-add has NO pre-selected category (3 taps).

All 15 frontend MVP tasks delivered on feat/frontend (uncommitted by me; tech lead commits). The throttle-refund backend bug was fixed in PR #6 (data-engineer) and MFA sign-in (TOTP, recovery code, passkey), re-auth with a second factor and TOTP confirm were verified against the real backend afterwards.

**Why:** owner paces work with checkpoints and reviews screenshots.
**How to apply:** remaining risk is device-only: iOS keypad auto-open on sheet open, keyboard inset, VoiceOver/TalkBack pass, PWA install on iPhone/Android, passkeys on real devices. Initial JS ~136 KB of 150: new screens must stay lazy.

Pre-launch hardening (2026-11-16, fix/pre-launch-hardening): F-51 (honest sign-out), F-52 (storage lint ban), F-54 (resume state bound to user ID) done, plus pending-deletion export, delayed revokeObjectURL, shared re-auth prompt, reset MFA_REQUIRED → MFA step. Still open by design: "Reload" banner reloads every tab (needs an owner decision), F-50 (with the Sentry PR), lastBudgetId in localStorage is not user-bound (ADR-0002 accepted; Home only uses it if it is in the new user's list).

Lost-tap follow-up (2026-11-16, fix/loading-tap-targets, owner ruling round 6): chose "gate controls below a variable-height loading region" over sized skeletons (no persisted cache under ADR-0002, so a "cached count" never exists when the skeleton shows). Quick-add sheet now opens before the budget loads. Rule written into frontend/CLAUDE.md. Round 7 owner rulings (2026-11-16): chip order frozen per sheet session (new categories go last; just-used leads on next open) and BudgetLayout prefetches the 50-item recent list (same key as the sheet).

