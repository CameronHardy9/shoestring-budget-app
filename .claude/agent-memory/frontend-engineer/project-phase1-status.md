---
name: project-phase1-status
description: Frontend build status, owner decisions and what still needs a real device, as of 2026-11-14 (MVP tasks 1-15 delivered on feat/frontend)
metadata:
  type: project
---
Owner decisions 2026-11-14: direction approved; brand Indigo; self-hosted Inter; Save & new kept; CSP allows the two React Aria sha256 hashes; quick-add has NO pre-selected category (3 taps).

All 15 frontend MVP tasks delivered on feat/frontend (uncommitted by me; tech lead commits). The throttle-refund backend bug was fixed in PR #6 (data-engineer) and MFA sign-in (TOTP, recovery code, passkey), re-auth with a second factor and TOTP confirm were verified against the real backend afterwards.

**Why:** owner paces work with checkpoints and reviews screenshots.
**How to apply:** remaining risk is device-only: iOS keypad auto-open on sheet open, keyboard inset, VoiceOver/TalkBack pass, PWA install on iPhone/Android, passkeys on real devices. Initial JS ~136 KB of 150: new screens must stay lazy.
