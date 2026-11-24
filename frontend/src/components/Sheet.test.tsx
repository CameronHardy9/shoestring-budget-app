import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { liftedMaxHeight, Sheet } from "./Sheet.tsx";

describe("liftedMaxHeight", () => {
  it("leaves the usual 85dvh alone while no keyboard is up", () => {
    expect(liftedMaxHeight(0, 844)).toBeUndefined();
  });

  it("caps the sheet to the visible height above the keyboard, below the notch", () => {
    expect(liftedMaxHeight(336, 508)).toBe(
      "min(85dvh, calc(508px - env(safe-area-inset-top) - 8px))",
    );
  });

  it("never goes negative", () => {
    expect(liftedMaxHeight(900, -12.4)).toBe(
      "min(85dvh, calc(0px - env(safe-area-inset-top) - 8px))",
    );
  });
});

describe("Sheet", () => {
  function renderSheet(bottomInset: number) {
    render(
      <Sheet
        title="Add transaction"
        isOpen
        onOpenChange={() => undefined}
        bottomInset={bottomInset}
        data-testid="sheet"
      >
        <input aria-label="Amount" />
      </Sheet>,
    );
    return screen.getByTestId("sheet");
  }

  it("is lifted by the inset and capped to the room left above it", () => {
    const dialog = renderSheet(300);
    // A fixed inset (no visualViewport): the window less the inset.
    const room = window.innerHeight - 300;
    expect(dialog.style.getPropertyValue("max-height")).toBe(
      `min(85dvh, calc(${String(room)}px - env(safe-area-inset-top) - 8px))`,
    );
    expect(dialog.closest(".shadow-3")).toHaveStyle({ marginBottom: "300px" });
  });

  describe("following the real keyboard", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("uses the visual viewport's height, even when iOS has panned it", () => {
      // Keyboard up and the view panned 50 px: the sheet's bottom sits at
      // the keyboard, and its top must stay inside the 400 px you can see.
      const listeners = new EventTarget();
      vi.stubGlobal("visualViewport", {
        height: 400,
        offsetTop: 50,
        addEventListener: listeners.addEventListener.bind(listeners),
        removeEventListener: listeners.removeEventListener.bind(listeners),
      });
      render(
        <Sheet
          title="Add transaction"
          isOpen
          onOpenChange={() => undefined}
          data-testid="sheet"
        >
          <input aria-label="Amount" />
        </Sheet>,
      );
      const dialog = screen.getByTestId("sheet");
      const inset = window.innerHeight - 400 - 50;
      expect(dialog.closest(".shadow-3")).toHaveStyle({
        marginBottom: `${String(inset)}px`,
      });
      expect(dialog.style.getPropertyValue("max-height")).toBe(
        "min(85dvh, calc(400px - env(safe-area-inset-top) - 8px))",
      );
    });
  });

  it("keeps its usual height with no keyboard", () => {
    const dialog = renderSheet(0);
    expect(dialog.style.getPropertyValue("max-height")).toBe("");
    expect(dialog).toHaveClass("max-h-[85dvh]");
  });
});
