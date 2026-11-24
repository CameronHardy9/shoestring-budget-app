import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LaceLoader } from "./LaceLoader.tsx";
import { LACE_CONTINUE_MS, LACE_CYCLE_MS } from "./lace-timing.ts";
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

  it("continues the running loader's phase, and starts afresh after a pause", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(100_000);
    const first = render(<LaceLoader />);
    expect(svg().style.getPropertyValue("--ss-lace-delay")).toBe("0ms");

    // Replaced in the same moment (one commit): picks up the running phase.
    now.mockReturnValue(101_000);
    first.unmount();
    const second = render(<LaceLoader />);
    expect(svg().style.getPropertyValue("--ss-lace-delay")).toBe("-1000ms");

    // A short gap still continues, wrapping at one cycle.
    now.mockReturnValue(100_000 + LACE_CYCLE_MS + 500);
    second.unmount();
    now.mockReturnValue(100_000 + LACE_CYCLE_MS + 500 + LACE_CONTINUE_MS);
    const third = render(<LaceLoader />);
    expect(svg().style.getPropertyValue("--ss-lace-delay")).toBe(
      `-${String(500 + LACE_CONTINUE_MS)}ms`,
    );

    // After a longer pause the next one starts from the beginning.
    now.mockReturnValue(200_000);
    third.unmount();
    now.mockReturnValue(200_000 + LACE_CONTINUE_MS + 1);
    render(<LaceLoader />);
    expect(svg().style.getPropertyValue("--ss-lace-delay")).toBe("0ms");
  });
});

describe("LoadingState", () => {
  it("is a polite status named by its label, with the loader inside", () => {
    render(<LoadingState label="Loading categories…" />);
    const status = screen.getByRole("status");
    expect(status).toBe(screen.getByTestId("loading"));
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Loading categories…");
    expect(status).toContainElement(svg());
    expect(status.querySelector(".animate-pulse")).toBeNull();
  });

  it("by default is the 96 px loader fixed in the middle of the viewport, taking no space and no taps", () => {
    render(<LoadingState />);
    const status = screen.getByTestId("loading");
    expect(status).toHaveAttribute("data-placement", "viewport");
    for (const name of [
      "fixed",
      "inset-0",
      "m-auto",
      "size-fit",
      "pointer-events-none",
      "z-20",
    ])
      expect(status).toHaveClass(name);
    expect(status.style.minHeight).toBe("");
    expect(svg()).toHaveAttribute("width", "96");
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
  it("shows the viewport loader with its label while not paused", () => {
    render(
      <PendingSlot
        paused={false}
        label="Loading members…"
        offlineMessage="Offline."
      />,
    );
    const status = screen.getByTestId("loading");
    expect(status).toHaveTextContent("Loading members…");
    expect(status).toHaveAttribute("data-placement", "viewport");
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
