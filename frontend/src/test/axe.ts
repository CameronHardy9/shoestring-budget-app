// axe-core in unit tests (jsdom). Fails on serious and critical violations,
// matching the e2e gate in ARCHITECTURE. Colour contrast cannot be computed in
// jsdom; tokens.test.ts checks contrast from the design tokens instead.
import axe from "axe-core";
import { expect } from "vitest";

export async function expectNoAxeViolations(container: Element): Promise<void> {
  const results = await axe.run(
    // React Aria's live announcer (a library-owned region in <body>) keeps
    // role="img" nodes labelled by elements that may have unmounted; it is
    // not our markup and is cleaned up in real browsers.
    { include: [container], exclude: [["[data-live-announcer]"]] },
    { rules: { "color-contrast": { enabled: false } } },
  );
  const serious = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map(
      (v) =>
        `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`,
    );
  expect(serious).toEqual([]);
}
