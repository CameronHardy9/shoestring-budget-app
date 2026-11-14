// The proposal screens must themselves be accessible: axe (serious/critical)
// on every preview screen, plus the split editor's live "left to assign".
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { expectNoAxeViolations } from "../test/axe.ts";
import { PreviewApp, SCREENS } from "./PreviewApp.tsx";

describe("style preview screens", () => {
  it.each([...SCREENS, null])(
    "%s has no serious axe violations",
    async (screenName) => {
      const { baseElement } = render(
        <PreviewApp screen={screenName} view="chart" />,
      );
      await expectNoAxeViolations(baseElement);
    },
  );

  it("offers the category table alternative", async () => {
    render(<PreviewApp screen="overview" view="chart" />);
    await userEvent.click(screen.getByRole("radio", { name: "Table" }));
    const table = screen.getByRole("table", { name: /Spending by category/ });
    expect(
      within(table).getByRole("rowheader", { name: "Dining out" }),
    ).toBeInTheDocument();
    expect(within(table).getByText("(over)")).toBeInTheDocument();
  });

  it("updates left to assign as split amounts change", async () => {
    render(<PreviewApp screen="quick-add-split" view="chart" />);
    const status = screen.getByTestId("split-left-to-assign");
    expect(status).toHaveTextContent("$6.40 left to assign");
    await userEvent.click(
      screen.getByRole("button", { name: "Put the rest on Household" }),
    );
    expect(status).toHaveTextContent("Fully assigned");
    expect(
      screen.getByRole("textbox", { name: "Amount for Household" }),
    ).toHaveValue("26.40");
  });
});
