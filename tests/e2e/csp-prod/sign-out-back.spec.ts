// C3.5 / F-32 on the PRODUCTION build: sign out, press Back, and the budget
// page must not show again. On csp-prod-chromium Back really restores the page
// from the back/forward cache (pageshow.persisted), so the app's pageshow
// handler is what keeps the data off screen. Playwright's WebKit never uses
// bfcache, so csp-prod-webkit covers the fresh-load path. Details and the
// evidence: e2e/sign-out-back.ts. The CSP gate (fixtures) applies here too.
import { test } from "../fixtures.ts";
import { signOutThenBack } from "../sign-out-back.ts";

test("after sign-out, Back shows no budget data and the session is gone (bfcache on Chromium)", async ({
  page,
  browserName,
}) => {
  await signOutThenBack(page, browserName === "chromium");
});
