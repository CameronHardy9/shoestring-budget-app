---
name: ios-keyboard-focus-theft
description: iOS PWA keyboard drops in sheets because React Aria Radio/Button taps move DOM focus off text inputs; sheet lift overflows top
metadata:
  type: project
---

Fragile area (diagnosed 2026-11-24): quick-add sheet keyboard closing on iPhone PWA.

- React Aria `useRadio` label onPress explicitly calls `ref.current.focus()` on the hidden radio input (react-aria dist private/radio/useRadio.mjs), so chip taps (ChipGroup = RAC RadioGroup/RadioButton) always steal focus. mousedown preventDefault on the label does NOT help.
- RAC Buttons take focus on tap in WebKit (Playwright WebKit focuses the button; real iOS may focus the Dialog's tabindex=-1 instead). `onMouseDown preventDefault` keeps focus; RA `preventFocusOnPress` only catches focus landing on the button itself.
- Proven in Playwright WebKit: refocusing the stashed text input in a queueMicrotask from a focusin-capture keeps focus and still selects the chip. On a real device, whether the keyboard stays relies on WebKit merging a blur and a refocus in the same task, so it needs testing on the phone.
- Sheet.tsx lifts by the keyboard inset, but Dialog max-h 85dvh ignores the inset, so with the text keyboard plus Note fields the header and Amount get pushed above the screen top.

**Why:** owner's top UX goal is three taps with the keyboard up; this area regresses easily when chips or buttons change.
**How to apply:** for any "keyboard closes / UI jumps" report, log focusin/focusout with relatedTarget in Playwright WebKit first. See [[diagnostic-preview-harness]].
