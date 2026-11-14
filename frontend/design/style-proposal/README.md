# Shoestring style proposal (Phase 1)

**Decision (owner, 2026-11-14, mvp-planning/10 "Build round 3"):** direction approved as shown;
brand **A Indigo**; font **self-hosted Inter variable** (latin subset, one 47 KB woff2) instead
of system fonts; "Save & new" stays next to Save. The `0x-*` screenshots below were re-rendered
with Inter. The `brand-*` files are the original multiple-choice options (system font) and are
kept as the record of the choice. Real screens: `../phase-2a/`.

Rendered from the dev-only preview (`frontend/preview.html`, `frontend/src/preview/`)
with invented data typed against the API contract. Phone shots are 390 × 844 CSS px
(iPhone 14/15 class) and desktop shots are 1280 × 800, all at 2× pixel density.
"full" and "table" shots show the whole scrolling page. Regenerate with
`pnpm --filter ./frontend screenshots`, which uses your installed Google Chrome.

**Direction:** calm, neutral greys with one brand colour, used only for actions,
progress and the current place. The numbers are the heroes: large, tabular,
high-contrast figures. Status (overspent, refund, left to assign) always carries
words and an icon, plus stripes on overspent bars, so colour is never the only
signal. Type is Inter (self-hosted), with the system UI font as the fallback.

## Files

| File                                                            | Shows                                                                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `01-signin-light.png`, `01-signin-dark.png`                     | Sign in                                                                                                                                                |
| `01-signin-error-light.png`                                     | Sign in after a wrong password (copy for `INVALID_CREDENTIALS`)                                                                                        |
| `02-overview-light.png`, `02-overview-dark.png`                 | Month overview, first screen: left to spend, categories as an SVG bar chart                                                                            |
| `03-overview-full-light.png`, `03-overview-full-dark.png`       | The whole overview page (income and recent transactions too)                                                                                           |
| `04-overview-table-light.png`, `04-overview-table-dark.png`     | The same categories as an accessible table (the "Table" toggle)                                                                                        |
| `05-quick-add-light.png`, `05-quick-add-dark.png`               | Quick-add sheet while typing the amount. The grey keypad is a picture of the phone's own decimal keypad, there only to show what stays in thumb reach. |
| `06-quick-add-split-light.png`, `06-quick-add-split-dark.png`   | Quick-add in split mode: "$6.40 left to assign" and "Put the rest on Household"                                                                        |
| `07-transactions-light.png`, `07-transactions-dark.png`         | Transactions grouped by day, with day totals and a category filter                                                                                     |
| `08-overview-desktop-light.png`, `08-overview-desktop-dark.png` | Overview at 1280 px wide, with the side rail instead of the bottom tab bar                                                                             |
| `brand-indigo-overview-{light,dark}.png`                        | Brand option A: Indigo (recommended)                                                                                                                   |
| `brand-teal-overview-{light,dark}.png`                          | Brand option B: Teal                                                                                                                                   |
| `brand-clay-overview-{light,dark}.png`                          | Brand option C: Clay (terracotta)                                                                                                                      |

## Quick-add in three taps

1. "+" (the centre of the tab bar, under the thumb) opens the sheet with the amount focused, so the decimal keypad is already up.
2. Type the amount, then tap a category chip. Chips are ordered by most recently used, 44 px tall, and sit right above the keypad.
3. Tap **Save**. It is the largest target, in the bottom third. "Save & new" keeps the sheet open for the next entry.

The date (today in the budget's timezone), note and split are one tap away and optional.

## Tokens (`src/styles/tokens.css`)

| Token                  | Light                 | Dark                  | Use                                            |
| ---------------------- | --------------------- | --------------------- | ---------------------------------------------- |
| canvas                 | `#f4f5f7`             | `#0e1014`             | App background                                 |
| surface                | `#ffffff`             | `#171a20`             | Cards, sheets, bars                            |
| sunken                 | `#edeff2`             | `#21252d`             | Segmented track, keypad, stripes               |
| line                   | `#e0e3e8`             | `#2a2f38`             | Dividers (decorative)                          |
| line-strong            | `#7d8591`             | `#6e7682`             | Input and control borders                      |
| fg                     | `#14161a`             | `#eceef1`             | Text                                           |
| fg-muted               | `#585f6a`             | `#a3aab5`             | Secondary text                                 |
| brand                  | `#4f46e5`             | `#a5acff`             | Primary buttons, bars, links, focus ring       |
| brand-strong           | `#4338ca`             | `#c3c7ff`             | Pressed state, text on brand-soft              |
| brand-soft             | `#eef0fe`             | `#272b52`             | Selected chip, active nav                      |
| on-brand               | `#ffffff`             | `#0e1014`             | Text on brand                                  |
| danger / danger-soft   | `#b42318` / `#fef1f0` | `#ff8a7a` / `#3a1d1a` | Overspent, errors                              |
| success / success-soft | `#067647` / `#e9f7ef` | `#4fd69c` / `#143024` | Money in, done                                 |
| warning / warning-soft | `#a15c07` / `#fdf4e3` | `#f5b544` / `#352a12` | Left to assign                                 |
| track                  | `#e2e5ea`             | `#2b3039`             | Empty part of a bar                            |
| focus                  | = brand               | = brand               | 2 px outline, 2 px offset, keyboard focus only |

Brand options (light / dark): **A Indigo** `#4f46e5` / `#a5acff`; **B Teal** `#0f766e` / `#4fd1c1`; **C Clay** `#b5441b` / `#f59e7a`.

- **Type:** Inter variable (self-hosted), system UI fallback. Sizes in px (line height): 13 (18), 14 (20), 16 (24), 18 (26), 20 (28), 24 (32), 32 (40), and 44 (52) for the quick-add amount. Inputs are never below 16 px, so iOS does not zoom.
- **Spacing:** 4 px grid. Touch targets are at least 44 × 44 px; primary buttons are 52 px tall.
- **Radius:** 6 (badges), 10 (inputs, buttons), 14 (cards), 20 (sheet corners), full (chips, pills).
- **Elevation:** 1 (cards), 2 (the "+" button, popovers), 3 (sheets). In dark mode, elevation comes mostly from lighter surfaces.
- **Theme:** dark follows the phone's setting. A manual switch later sets `<html data-theme>`.

## Contrast (WCAG 2.2 AA, enforced by `scripts/tokens-contrast.test.ts` in `make check`)

| Pair                                  | Light              | Dark               | Needs |
| ------------------------------------- | ------------------ | ------------------ | ----- |
| fg on surface / canvas                | 18.11 / 16.60      | 14.99 / 16.38      | 4.5   |
| fg-muted on surface / canvas / sunken | 6.44 / 5.91 / 5.59 | 7.45 / 8.14 / 6.56 | 4.5   |
| on-brand on brand                     | 6.29               | 9.02               | 4.5   |
| brand on surface (links)              | 6.29               | 8.25               | 4.5   |
| brand-strong on brand-soft            | 6.97               | 8.32               | 4.5   |
| danger on surface / danger-soft       | 6.57 / 5.97        | 7.61 / 6.69        | 4.5   |
| success on surface                    | 5.69               | 9.49               | 4.5   |
| warning on warning-soft               | 4.75               | 7.76               | 4.5   |
| line-strong on surface / sunken       | 3.73 / 3.23        | 3.80 / 3.35        | 3.0   |
| focus ring on canvas                  | 5.76               | 9.02               | 3.0   |
| brand / danger bar on track           | 4.98 / 5.21        | 6.28 / 5.79        | 3.0   |

Teal (light / dark): on-brand on brand 5.47 / 10.18, brand on track 4.33 / 7.08.
Clay: 5.52 / 9.12 and 4.37 / 6.35. Every option passes every pair in the test.
