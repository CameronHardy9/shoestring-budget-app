# Release checklist (owner, before each beta release)

About 30 minutes on your own phone(s), against the **deployed** site
(`https://shoestring.<domain>`), after `make check`, `make e2e` and the deploy
smoke test are green. Automated tests use emulated devices; this page covers
what only a real phone, a real keyboard and a real screen reader can show.
Use a throwaway test budget with made-up amounts; never real data in screenshots.

Tick each box, note the build (`/api/healthz` `version`) and the date. Anything
that fails is a release blocker unless you decide otherwise and write down why.

Build: ____________  Date: ____________  iPhone / iOS: ____________  Android / Chrome: ____________

## 1. Smoke test on your phone (iPhone Safari, then installed app)
- [ ] Sign in with your password (and second factor if you use one). A "new sign-in" email arrives.
- [ ] **Quick-add, one-handed:** tap **+**. The **numeric keypad opens by itself** with the amount focused. Type an amount, tap a category, tap **Save**: 3 taps, under 10 seconds.
- [ ] While the keypad is up, **Save stays visible above the keyboard** (not hidden behind it), and the sheet does not jump or zoom when typing (inputs are 16 px).
- [ ] The overview's "Left to spend" changes by exactly that amount; the transaction shows under Recent with today's date.
- [ ] Split a transaction across two categories: "left to assign" counts down, Save works when it reaches "Fully assigned".
- [ ] Edit that transaction, then delete it: totals go back.
- [ ] Rotate to landscape and back: nothing overlaps or gets cut off.
- [ ] Dark mode (Settings › Display › Dark): text stays readable, overspending still says "Over by" (not only red).
- [ ] **Back after sign-out, in Safari** (C3.5 / F-32): open a budget, go to More, sign out, then swipe back. No budget numbers or payees appear, **not even for a moment**; you end up on sign-in. Safari's back/forward cache is the case the automated tests cannot reach (Playwright's WebKit never uses it).

## 2. Installed app (PWA), offline and update
- [ ] Safari › Share › **Add to Home Screen**. Open from the home screen: it opens full screen with the Shoestring icon and name.
- [ ] In the installed app, sign in and quick-add once.
- [ ] Turn on Airplane mode, then reopen the app: the app shell loads and says it is offline; **no budget numbers or transactions are shown** from a cache.
- [ ] Still offline, try to save a transaction: it says it could not save and **keeps what you typed**. Back online, Retry saves it once (no duplicate).
- [ ] After the next deploy: reopen the installed app. An **update banner** appears; it never reloads by itself. Tap Reload: the new version loads (check the version in Settings or `/api/healthz`).
- [ ] **CSV export inside the installed app** (More › Account › Export): the file downloads and opens (Files / Numbers / Sheets) with your test rows.
- [ ] Sign out, then use the back gesture: no financial screen comes back; you see sign-in.

## 3. Passkeys with Face ID / fingerprint
- [ ] iPhone: Settings › Security › add a passkey; **Face ID** prompts and the passkey appears in the list.
- [ ] Sign out, sign in with password, choose passkey: Face ID completes the sign-in.
- [ ] Android: same with **fingerprint** in Chrome.
- [ ] A re-auth prompt (e.g. inviting someone) accepts the passkey.
- [ ] Remove the passkey you added for the test (and you received the "factor added/removed" emails).

## 4. VoiceOver (iPhone)
Turn on: Settings › Accessibility › VoiceOver (or triple-click the side button if set up).
- [ ] Sign in by swiping through fields: each field and button is announced with a clear name ("Email", "Password", "Sign in").
- [ ] Overview: the month, "Left to spend $…", and each category with planned, spent and left are read; an overspent one says "Over by". The chart is skipped or read as text, and the **Table** view reads row by row.
- [ ] Quick-add: "Add transaction" button; in the sheet the amount field, the category chips (as a group of options, the selected one announced), Split, Save; after Save the confirmation toast is announced.
- [ ] Split editor: each row's category and amount are announced; "left to assign" is announced as it changes.
- [ ] Dialogs (delete, re-auth): focus moves into the dialog, the title is read, and closing returns focus to where you were.
- [ ] Navigating between tabs announces the new screen's heading.

## 5. TalkBack (Android Chrome)
Turn on: Settings › Accessibility › TalkBack.
- [ ] Repeat the VoiceOver steps above (sign in, overview + table, quick-add with chips and Split, a dialog).
- [ ] Every button has a spoken name (no "unlabelled button").
- [ ] Touch targets are easy to hit with one thumb (44 px or more).

## 6. Data and safety spot checks
- [ ] A household member on another phone sees your test transaction within a refresh; someone outside the budget cannot open its link (they see "not found").
- [ ] Emails you received this session (sign-in, factor changes) contain no amounts or payees, and every link goes to `https://shoestring.<domain>`.
- [ ] Delete the test budget (it can be restored for 30 days; leave it deleted).

Sign-off: ____________
