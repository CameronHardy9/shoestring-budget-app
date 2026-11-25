---
name: ios-keyboard-focus-theft
description: iOS PWA keyboard drops in sheets because React Aria Radio/Button taps move DOM focus off text inputs; sheet lift overflows top
metadata:
  type: project
---

Fragile area (diagnosed 2026-11-24): quick-add sheet keyboard closing on iPhone PWA.

- HISTORY: React Aria `useRadio` label onPress explicitly calls `ref.current.focus()` on the hidden radio input (react-aria dist private/radio/useRadio.mjs), so RAC chip taps always stole focus; mousedown preventDefault on the label did NOT help. Since fix/custom-chips (PR #40, 2026-11-25) ChipGroup is our own `<button role="radio">` group with no RAC radio: a tap fires no focus events while a text field has focus.
- RAC Buttons take focus on tap in WebKit (Playwright WebKit focuses the button; real iOS may focus the Dialog's tabindex=-1 instead). `onMouseDown preventDefault` keeps focus; RA `preventFocusOnPress` only catches focus landing on the button itself.
- FAILED on the real iPhone (owner, 2026-11-25): refocusing the text input in a microtask (`keepTextFocus`, #36) passed in Playwright WebKit but the KEYBOARD flickered on device. Never blur and refocus; keep focus from moving at all.
- Slow presses: iOS is expected to send no click after a long touch; React Aria's 80 ms fallback then focuses the button. `useSlowPress` clicks at 70 ms in the keepFocus paths (reproduced only with scripted touches; not confirmed on a device).
- FIXED in #36: Sheet.tsx lifted by the keyboard inset while Dialog max-h 85dvh ignored it, pushing the header and Amount off the top. maxHeight is now capped to the visible area while the inset is above 0.

**Why:** owner's top UX goal is three taps with the keyboard up; this area regresses easily when chips or buttons change.
**How to apply:** for any "keyboard closes / UI jumps" report, log focusin/focusout with relatedTarget in Playwright WebKit first. See [[diagnostic-preview-harness]].
