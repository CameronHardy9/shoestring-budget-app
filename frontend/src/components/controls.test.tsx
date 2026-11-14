import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoAxeViolations } from "../test/axe.ts";
import { BudgetBar, usedFraction } from "./BudgetBar.tsx";
import { Button } from "./Button.tsx";
import { ChipGroup } from "./ChipGroup.tsx";
import { Money } from "./Money.tsx";
import { SegmentedControl } from "./SegmentedControl.tsx";

describe("SegmentedControl", () => {
  it("changes on press, ignores re-selecting, and never empties", async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Type"
        value="outflow"
        onChange={onChange}
        options={[
          { id: "outflow", label: "Spent" },
          { id: "inflow", label: "Received" },
        ]}
      />,
    );
    const spent = screen.getByRole("radio", { name: "Spent" });
    expect(spent).toBeChecked();
    await userEvent.click(spent);
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("radio", { name: "Received" }));
    expect(onChange).toHaveBeenCalledWith("inflow");
  });
});

describe("ChipGroup", () => {
  const chips = [
    { id: "a", label: "Groceries" },
    { id: "b", label: "Dining out" },
  ];

  it("is a labelled radio group operable by keyboard", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <ChipGroup
        label="Category"
        chips={chips}
        value="a"
        onChange={onChange}
      />,
    );
    const group = screen.getByRole("radiogroup", { name: "Category" });
    expect(group).toBeInTheDocument();
    screen.getByRole("radio", { name: "Groceries" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith("b");
    await expectNoAxeViolations(container);
  });

  it("shows an error message", () => {
    render(
      <ChipGroup
        label="Category"
        chips={chips}
        value={null}
        onChange={vi.fn()}
        errorMessage="Choose a category."
      />,
    );
    expect(screen.getByText("Choose a category.")).toBeInTheDocument();
  });
});

describe("BudgetBar", () => {
  it("draws the share used, capped at the plan", () => {
    expect(usedFraction(1000, 0)).toBe(0);
    expect(usedFraction(1000, -50)).toBe(0);
    expect(usedFraction(1000, 250)).toBe(0.25);
    expect(usedFraction(1000, 5000)).toBe(1);
    expect(usedFraction(0, 1)).toBe(1);
  });

  it("is hidden from assistive tech and marks overspending with a pattern", () => {
    const { container, rerender } = render(
      <BudgetBar plannedCents={100} actualCents={150} />,
    );
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("data-over", "true");
    expect(container.querySelector("pattern")).not.toBeNull();
    rerender(<BudgetBar plannedCents={100} actualCents={0} />);
    expect(container.querySelector("pattern")).toBeNull();
    expect(container.querySelectorAll("rect")).toHaveLength(1);
  });
});

describe("Button and Money", () => {
  it("renders an accessible button that reports presses", async () => {
    const onPress = vi.fn();
    render(
      <Button
        onPress={onPress}
        variant="secondary"
        size="sm"
        shape="pill"
        weight="medium"
      >
        Save
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onPress).toHaveBeenCalledOnce();
  });

  it("formats cents", () => {
    render(<Money cents={-2310} />);
    expect(screen.getByText("-$23.10")).toBeInTheDocument();
  });
});
