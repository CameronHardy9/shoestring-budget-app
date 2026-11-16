// Shared Playwright fixtures for e2e/ and visual/:
//   - before every test: POST /api/_test/reset, outbox cleared, clock frozen
//     (support/hooks.ts), exactly as the API suites;
//   - every page reports `securitypolicyviolation` events from the first
//     script on, into a Node-side list that survives navigations (F-55); any
//     violation on ANY document the test visited fails it (C3.1). Only the
//     production build sends a CSP (csp-prod projects, visual suite); the Vite
//     dev server sends none. Uncaught page errors fail the test too;
//   - after every test: every captured email must follow auth.md §15.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test as base, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { emailProblems } from "../support/emails.ts";
import { emails, resetStack, runTeardowns } from "../support/hooks.ts";

declare global {
  interface Window {
    /** Playwright binding: hands one violation to the test's CspViolations. */
    __cspViolation?: (v: CspViolation) => Promise<void>;
  }
}

/** One `securitypolicyviolation` event, as reported by the page. */
export interface CspViolation {
  /** Page URL (path only) of the document that reported it. */
  page: string;
  directive: string;
  /** `blockedURI`, or "inline" for inline styles and scripts. */
  blocked: string;
  /** First 40 characters of the blocked inline code, when the browser sends it. */
  sample: string;
  /** Script that caused it ("" for evaluated code), and the position in it. */
  sourceFile: string;
  line: number;
  column: number;
}

/**
 * The violations of every document the test's page has had. Kept in Node, so
 * a navigation (page.goto, a full reload, location.replace) cannot lose them.
 */
export class CspViolations {
  readonly list: CspViolation[] = [];
  /** Removes and returns the violations that match (self-checks and snap()). */
  take(match: (v: CspViolation) => boolean): CspViolation[] {
    const taken = this.list.filter(match);
    for (const v of taken) this.list.splice(this.list.indexOf(v), 1);
    return taken;
  }
}

/** The teardown check, exported so the gate's self-check can prove it fails. */
export function expectNoCspViolations(v: CspViolations): void {
  expect(
    v.list.map((x) => `${x.page}: ${x.directive} ${x.blocked} ${x.sample}`.trim()),
    "Content-Security-Policy violations on any page of this test (C3.1)",
  ).toEqual([]);
}

/**
 * Lets every violation the page has dispatched so far reach Node: violation
 * events are queued tasks, and the binding call is asynchronous.
 */
export async function flushCspViolations(page: Page): Promise<void> {
  if (page.isClosed()) return;
  await page
    .evaluate(
      () =>
        new Promise<void>((resolve) => {
          const ch = new MessageChannel();
          ch.port1.onmessage = () => resolve();
          ch.port2.postMessage(null);
        }),
    )
    .catch(() => undefined);
}

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

interface Fixtures {
  /** Tap counter for this test's device (touch or mouse). */
  taps: Taps;
  /** CSP violations of every document of `page` (asserted empty at teardown). */
  cspViolations: CspViolations;
}

export const test = base.extend<Fixtures, { dalLifecycle: undefined }>({
  dalLifecycle: [
    // Playwright's fixture API requires an object pattern, even an empty one.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use(undefined);
      await runTeardowns();
    },
    { scope: "worker", auto: true },
  ],
  taps: async ({ hasTouch }, use) => {
    await use(new Taps(hasTouch));
  },
  // eslint-disable-next-line no-empty-pattern
  cspViolations: async ({}, use) => {
    await use(new CspViolations());
  },
  page: async ({ page, cspViolations }, use, testInfo) => {
    await resetStack();
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.exposeBinding("__cspViolation", (_source, v: CspViolation) => {
      cspViolations.list.push(v);
    });
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => {
        // Not optional: a missing binding throws, which fails the test as an
        // uncaught page error instead of dropping the violation. The report is
        // sent synchronously; a rejection after that (page closing) is moot.
        window
          .__cspViolation!({
            page: location.pathname,
            directive: e.violatedDirective,
            blocked: e.blockedURI || "inline",
            sample: e.sample,
            sourceFile: e.sourceFile,
            line: e.lineNumber,
            column: e.columnNumber,
          })
          .catch(() => undefined);
      });
    });
    await use(page);
    if (testInfo.status !== testInfo.expectedStatus) return; // keep the first failure readable
    await flushCspViolations(page);
    expectNoCspViolations(cspViolations);
    expect(pageErrors, "uncaught errors in the page").toEqual([]);
    const problems = (await emails()).flatMap(emailProblems);
    expect(problems, "captured emails must follow auth.md §15").toEqual([]);
  },
});

export { expect };

/** Signs the browser in through POST /api/_test/login (shares the context's cookie jar). */
export async function signInAs(page: Page, email: string): Promise<void> {
  const res = await page.request.post("/api/_test/login", { data: { email } });
  expect(res.status(), "test login").toBe(200);
}

/**
 * axe-core on the current screen: fails on any serious or critical violation
 * (owner decision, meeting 5). Injected with evaluate, which page CSP does not
 * govern, so the scan works on the production build too.
 */
export async function expectAccessible(
  page: Page,
  screen: string,
): Promise<void> {
  await page.evaluate(AXE_SOURCE);
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            ctx: object,
            opts: object,
          ) => Promise<{
            violations: {
              id: string;
              impact: string | null;
              help: string;
              nodes: { target: unknown[] }[];
            }[];
          }>;
        };
      }
    ).axe;
    // Excluded: React Aria's live announcer, a library-owned, visually hidden
    // region prepended to <body>. Each announcement is a transient
    // `div role="img" aria-labelledby=…` whose target is often already gone
    // when the scan runs, so axe reports role-img-alt on library internals.
    // Same exclusion and reason as frontend/src/test/axe.ts. Everything the
    // app renders is scanned.
    const r = await axe.run(
      { include: [["body"]], exclude: [["[data-live-announcer]"]] },
      { resultTypes: ["violations"] },
    );
    return r.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map(
        (v) =>
          `${v.impact ?? ""} ${v.id}: ${v.help} (${v.nodes.map((n) => JSON.stringify(n.target)).join(", ")})`,
      );
  });
  expect(violations, `axe serious/critical violations on ${screen}`).toEqual(
    [],
  );
}

/**
 * Counts taps for the quick-add bar ("3 taps", ARCHITECTURE "Great"): every
 * pointer interaction in a journey goes through tap(); typing is not a tap.
 * Touch projects tap, desktop clicks.
 */
export class Taps {
  count = 0;
  private readonly touch: boolean;
  constructor(touch: boolean) {
    this.touch = touch;
  }
  async tap(target: Locator): Promise<void> {
    this.count += 1;
    if (this.touch) await target.tap();
    else await target.click();
  }
}

/** The quick-add opener for the current layout (bottom FAB on phones, rail button on desktop). */
export function quickAddOpener(page: Page): Locator {
  return page
    .getByTestId("quick-add-open")
    .or(page.getByTestId("quick-add-open-rail"))
    .locator("visible=true")
    .first();
}
