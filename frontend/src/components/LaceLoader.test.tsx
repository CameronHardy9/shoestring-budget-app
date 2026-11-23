import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LaceLoader } from "./LaceLoader.tsx";
import { LoadingState, PendingSlot, loadingMinHeight } from "./States.tsx";

function svg(): SVGSVGElement {
  return screen.getByTestId("lace-loader") as unknown as SVGSVGElement;
}

describe("LaceLoader", () => {
  it("is decorative: hidden from assistive technology, not focusable", () => {
    render(<LaceLoader />);
    expect(svg()).toHaveAttribute("aria-hidden", "true");
    expect(svg()).toHaveAttribute("focusable", "false");
    expect(svg()).toHaveAttribute("viewBox", "0 0 64 64");
  });

  it("draws tile, lace, tip, then four eyelets (ring + hole) on top, at 56 px by default", () => {
    render(<LaceLoader />);
    expect(svg()).toHaveAttribute("width", "56");
    expect(svg()).toHaveAttribute("height", "56");
    const layers = [...svg().children].map(
      (el) =>
        el.getAttribute("class") ??
        (el.hasAttribute("data-eyelet") ? "eyelet" : el.tagName),
    );
    expect(layers).toEqual([
      "ss-lace-tile",
      "ss-lace-line",
      "ss-lace-tip",
      "eyelet",
      "eyelet",
      "eyelet",
      "eyelet",
    ]);
    const line = svg().querySelector(".ss-lace-line")!;
    const tip = svg().querySelector(".ss-lace-tip")!;
    expect(line).toHaveAttribute("pathLength", "1");
    expect(line).toHaveAttribute("stroke-width", "5.5");
    expect(line).toHaveAttribute("stroke-linecap", "round");
    expect(tip).toHaveAttribute("pathLength", "1");
    expect(tip).toHaveAttribute("stroke-width", "7");
    expect(tip).toHaveAttribute("stroke-linecap", "butt");
    expect(tip.getAttribute("d")).toBe(line.getAttribute("d"));
    const centres = [...svg().querySelectorAll(".ss-lace-hole")].map(
      (c) => `${c.getAttribute("cx")},${c.getAttribute("cy")}`,
    );
    expect(centres).toEqual(["18,18", "46,18", "18,46", "46,46"]);
  });

  it("at 24 px and below drops the eyelets and the tip and thickens the lace", () => {
    render(<LaceLoader size={24} />);
    expect(svg()).toHaveAttribute("width", "24");
    expect(svg().querySelector(".ss-lace-tip")).toBeNull();
    expect(svg().querySelectorAll("[data-eyelet]")).toHaveLength(0);
    expect(svg().querySelector(".ss-lace-line")).toHaveAttribute(
      "stroke-width",
      "7",
    );
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

  it("reserves the old skeleton's height through rows (h-16 rows, gap-3)", () => {
    expect(loadingMinHeight(1)).toBe("4rem");
    expect(loadingMinHeight(2)).toBe("8.75rem");
    expect(loadingMinHeight(3)).toBe("13.5rem");
    expect(loadingMinHeight(0)).toBe("4rem");
    const { rerender } = render(<LoadingState />);
    expect(screen.getByTestId("loading").style.minHeight).toBe("13.5rem");
    rerender(<LoadingState rows={1} />);
    expect(screen.getByTestId("loading").style.minHeight).toBe("4rem");
  });

  it("uses the 56 px loader in content and the 96 px one for full-screen loads", () => {
    const { rerender } = render(<LoadingState />);
    expect(svg()).toHaveAttribute("width", "56");
    rerender(<LoadingState size="lg" />);
    expect(svg()).toHaveAttribute("width", "96");
  });

  it("is what PendingSlot shows while not paused, with its rows and label", () => {
    render(
      <PendingSlot
        paused={false}
        rows={2}
        label="Loading members…"
        offlineMessage="Offline."
      />,
    );
    const status = screen.getByTestId("loading");
    expect(status).toHaveTextContent("Loading members…");
    expect(status.style.minHeight).toBe("8.75rem");
  });
});
