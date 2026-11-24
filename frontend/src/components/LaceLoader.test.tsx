import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LaceLoader, laceDelay } from "./LaceLoader.tsx";
import { LACE_CYCLE_MS } from "./lace-timing.ts";
import { LoadingState, PendingSlot, loadingMinHeight } from "./States.tsx";

function svg(): SVGSVGElement {
  return screen.getByTestId("lace-loader") as unknown as SVGSVGElement;
}

function layers(): string[] {
  return [...svg().children].map(
    (el) =>
      el.getAttribute("class") ??
      (el.hasAttribute("data-eyelet") ? "eyelet" : el.tagName),
  );
}

describe("LaceLoader", () => {
  it("is decorative: hidden from assistive technology, not focusable", () => {
    render(<LaceLoader />);
    expect(svg()).toHaveAttribute("aria-hidden", "true");
    expect(svg()).toHaveAttribute("focusable", "false");
    expect(svg()).toHaveAttribute("viewBox", "0 0 64 64");
  });

  it("draws tile, tongue, tongue lines, lace edge, lace, tip, then four eyelets on top, at 56 px by default", () => {
    render(<LaceLoader />);
    expect(svg()).toHaveAttribute("width", "56");
    expect(svg()).toHaveAttribute("height", "56");
    expect(layers()).toEqual([
      "ss-lace-tile",
      "ss-lace-tongue",
      "ss-lace-tongue-line",
      "ss-lace-dark",
      "ss-lace-line",
      "ss-lace-tip",
      "eyelet",
      "eyelet",
      "eyelet",
      "eyelet",
    ]);
    const tile = svg().querySelector(".ss-lace-tile")!;
    expect(tile).toHaveAttribute("stroke-width", "1");
    expect(tile).toHaveAttribute("vector-effect", "non-scaling-stroke");
    expect(svg().querySelector(".ss-lace-tongue")).toHaveAttribute(
      "d",
      "M27 0 L27 55 Q27 61 32 61 Q37 61 37 55 L37 0 Z",
    );
    const tongueLines = svg().querySelector(".ss-lace-tongue-line")!;
    expect(tongueLines).toHaveAttribute("d", "M27 7 L27 58 M37 7 L37 58");
    expect(tongueLines).toHaveAttribute("stroke-width", "3.2");
    expect(tongueLines).toHaveAttribute("stroke-linecap", "round");

    const edge = svg().querySelector(".ss-lace-dark")!;
    const line = svg().querySelector(".ss-lace-line")!;
    const tip = svg().querySelector(".ss-lace-tip")!;
    for (const lace of [edge, line, tip]) {
      expect(lace).toHaveAttribute("pathLength", "1");
      expect(lace.getAttribute("d")).toBe(line.getAttribute("d"));
    }
    expect(edge).toHaveAttribute("stroke-width", "7.6");
    expect(edge).toHaveAttribute("stroke-linecap", "round");
    expect(line).toHaveAttribute("stroke-width", "5.5");
    expect(line).toHaveAttribute("stroke-linecap", "round");
    expect(tip).toHaveAttribute("stroke-width", "7");
    expect(tip).toHaveAttribute("stroke-linecap", "butt");
    const centres = [...svg().querySelectorAll(".ss-lace-hole")].map(
      (c) => `${c.getAttribute("cx")},${c.getAttribute("cy")}`,
    );
    expect(centres).toEqual(["18,18", "46,18", "18,46", "46,46"]);
  });

  it("at 24 px and below keeps only the tile and the lace, drawn dark and thicker", () => {
    render(<LaceLoader size={24} />);
    expect(svg()).toHaveAttribute("width", "24");
    expect(layers()).toEqual(["ss-lace-tile", "ss-lace-dark"]);
    expect(svg().querySelector(".ss-lace-dark")).toHaveAttribute(
      "stroke-width",
      "7",
    );
  });

  it("starts its CSS animation at its epoch's phase (a negative delay), wrapping at one cycle", () => {
    expect(laceDelay(0)).toBe("0ms");
    expect(laceDelay(1000)).toBe("-1000ms");
    expect(laceDelay(LACE_CYCLE_MS + 500.4)).toBe("-500ms");
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(100_000);
    const first = render(<LaceLoader epoch={100_000 - 1000} />);
    expect(svg().style.getPropertyValue("--ss-lace-delay")).toBe("-1000ms");
    first.unmount();
    render(<LaceLoader epoch={100_000 - 2 * LACE_CYCLE_MS - 250} />);
    expect(svg().style.getPropertyValue("--ss-lace-delay")).toBe("-250ms");
  });

  it("without an epoch and no page loader on screen, starts from the beginning", () => {
    vi.spyOn(performance, "now").mockReturnValue(100_000);
    render(<LaceLoader />);
    expect(svg().style.getPropertyValue("--ss-lace-delay")).toBe("0ms");
  });
});

describe("LoadingState", () => {
  it("inline is a polite status named by its label, with the loader inside, at once", () => {
    render(<LoadingState placement="inline" label="Loading categories…" />);
    const status = screen.getByRole("status");
    expect(status).toBe(screen.getByTestId("loading"));
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Loading categories…");
    expect(status).toContainElement(svg());
    expect(status.querySelector(".animate-pulse")).toBeNull();
  });

  it("by default is only an empty marker in the page: the lace is the app-level PageLoader's", () => {
    render(<LoadingState label="Loading your budget…" />);
    const slot = screen.getByTestId("loading-slot");
    expect(slot).toBeEmptyDOMElement();
    expect(slot).not.toBeVisible();
    expect(slot).toHaveAttribute("data-label", "Loading your budget…");
    expect(screen.queryByTestId("loading")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("inline is the 56 px loader in a box the old skeleton's height (h-16 rows, gap-3)", () => {
    expect(loadingMinHeight(1)).toBe("4rem");
    expect(loadingMinHeight(2)).toBe("8.75rem");
    expect(loadingMinHeight(3)).toBe("13.5rem");
    expect(loadingMinHeight(0)).toBe("4rem");
    const { rerender } = render(<LoadingState placement="inline" />);
    const status = screen.getByTestId("loading");
    expect(status).toHaveAttribute("data-placement", "inline");
    expect(status).not.toHaveClass("fixed");
    expect(status.style.minHeight).toBe("13.5rem");
    expect(svg()).toHaveAttribute("width", "56");
    rerender(<LoadingState placement="inline" rows={1} />);
    expect(screen.getByTestId("loading").style.minHeight).toBe("4rem");
  });
});

describe("PendingSlot", () => {
  it("is a page load with its label while not paused", () => {
    render(
      <PendingSlot
        paused={false}
        label="Loading members…"
        offlineMessage="Offline."
      />,
    );
    expect(screen.getByTestId("loading-slot")).toHaveAttribute(
      "data-label",
      "Loading members…",
    );
    expect(screen.queryByTestId("offline")).toBeNull();
  });

  it("passes an inline placement and its rows through", () => {
    render(
      <PendingSlot
        paused={false}
        placement="inline"
        rows={2}
        offlineMessage="Offline."
      />,
    );
    const status = screen.getByTestId("loading");
    expect(status).toHaveAttribute("data-placement", "inline");
    expect(status.style.minHeight).toBe("8.75rem");
  });

  it("is the in-flow offline box, not a loader, when paused or once rows below are shown", () => {
    const { rerender } = render(
      <PendingSlot paused offlineMessage="You're offline." />,
    );
    expect(screen.getByTestId("offline")).toHaveTextContent("You're offline.");
    expect(screen.queryByTestId("loading")).toBeNull();
    expect(screen.queryByTestId("loading-slot")).toBeNull();
    expect(screen.queryByTestId("lace-loader")).toBeNull();
    rerender(
      <PendingSlot
        paused={false}
        rowsBelowShown
        offlineMessage="You're offline."
      />,
    );
    expect(screen.getByTestId("offline")).toHaveTextContent(
      "Back online. Loading…",
    );
    expect(screen.queryByTestId("loading")).toBeNull();
  });
});
