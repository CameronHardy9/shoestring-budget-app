import { fireEvent, render, screen } from "@testing-library/react";
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

describe("SegmentedControl keepFocus", () => {
  function renderControl(onChange = vi.fn()) {
    render(
      <>
        <input aria-label="Amount" />
        <SegmentedControl
          label="Type"
          value="outflow"
          onChange={onChange}
          keepFocus
          options={[
            { id: "outflow", label: "Spent" },
            { id: "inflow", label: "Received" },
          ]}
        />
      </>,
    );
    return onChange;
  }

  it("changes on a tap and leaves the text field focused", async () => {
    const onChange = renderControl();
    const amount = screen.getByRole("textbox", { name: "Amount" });
    amount.focus();
    await userEvent.click(screen.getByRole("radio", { name: "Received" }));
    expect(onChange).toHaveBeenCalledWith("inflow");
    expect(amount).toHaveFocus();
    expect(
      fireEvent.mouseDown(screen.getByRole("radio", { name: "Spent" })),
    ).toBe(false);
  });

  it("still takes keyboard focus and moves with the arrow keys", async () => {
    const onChange = renderControl();
    screen.getByRole("textbox", { name: "Amount" }).focus();
    await userEvent.tab();
    expect(screen.getByRole("radio", { name: "Spent" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Received" })).toHaveFocus();
    await userEvent.keyboard(" ");
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

  describe("keepTextFocus", () => {
    function renderWithField(onChange = vi.fn()) {
      render(
        <>
          <input aria-label="Amount" inputMode="decimal" />
          <ChipGroup
            label="Category"
            chips={chips}
            value="a"
            onChange={onChange}
            keepTextFocus
          />
        </>,
      );
      const amount = screen.getByRole("textbox", { name: "Amount" });
      amount.focus();
      return { amount, onChange };
    }

    it("selects the tapped chip and leaves the text field focused", async () => {
      const { amount, onChange } = renderWithField();
      await userEvent.click(screen.getByText("Dining out"));
      expect(onChange).toHaveBeenCalledWith("b");
      expect(amount).toHaveFocus();
    });

    it("still lets Tab and the arrow keys focus and select the radios", async () => {
      const { amount, onChange } = renderWithField();
      // A tap first, so nothing from it can linger into the keyboard path.
      await userEvent.click(screen.getByText("Dining out"));
      expect(amount).toHaveFocus();
      await userEvent.tab();
      expect(screen.getByRole("radio", { name: "Groceries" })).toHaveFocus();
      await userEvent.keyboard("{ArrowRight}");
      expect(onChange).toHaveBeenLastCalledWith("b");
      expect(screen.getByRole("radio", { name: "Dining out" })).toHaveFocus();
    });

    it("lets a screen reader's activation focus the radio", () => {
      const { onChange } = renderWithField();
      const label = screen.getByText("Dining out");
      // VoiceOver's synthetic pointer events have zero size; its click has
      // detail 0 (React Aria's "virtual" press).
      const down = new MouseEvent("pointerdown", { bubbles: true });
      Object.defineProperties(down, {
        width: { value: 0 },
        height: { value: 0 },
      });
      label.dispatchEvent(down);
      fireEvent.click(label);
      expect(onChange).toHaveBeenCalledWith("b");
      expect(screen.getByRole("radio", { name: "Dining out" })).toHaveFocus();
    });

    it("is off by default: a tap focuses the radio, as React Aria does", async () => {
      render(
        <>
          <input aria-label="Amount" />
          <ChipGroup
            label="Category"
            chips={chips}
            value="a"
            onChange={vi.fn()}
          />
        </>,
      );
      screen.getByRole("textbox", { name: "Amount" }).focus();
      await userEvent.click(screen.getByText("Dining out"));
      expect(screen.getByRole("radio", { name: "Dining out" })).toHaveFocus();
    });
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

  it("keepFocus: a tap or click leaves focus in the text field", async () => {
    const onPress = vi.fn();
    const onMouseDown = vi.fn();
    render(
      <>
        <input aria-label="Payee" />
        <Button keepFocus onPress={onPress} onMouseDown={onMouseDown}>
          Save
        </Button>
      </>,
    );
    const payee = screen.getByRole("textbox", { name: "Payee" });
    const save = screen.getByRole("button", { name: "Save" });
    payee.focus();
    await userEvent.click(save);
    expect(onPress).toHaveBeenCalledOnce();
    expect(onMouseDown).toHaveBeenCalledOnce();
    expect(payee).toHaveFocus();
    // The mousedown default (what moves focus) is cancelled.
    expect(fireEvent.mouseDown(save)).toBe(false);
  });

  it("keepFocus: keyboard focus and activation are unchanged", async () => {
    const onPress = vi.fn();
    render(
      <>
        <input aria-label="Payee" />
        <Button keepFocus onPress={onPress}>
          Save
        </Button>
      </>,
    );
    screen.getByRole("textbox", { name: "Payee" }).focus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it("without keepFocus a click focuses the button", async () => {
    render(
      <>
        <input aria-label="Payee" />
        <Button>Save</Button>
      </>,
    );
    screen.getByRole("textbox", { name: "Payee" }).focus();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    expect(fireEvent.mouseDown(screen.getByRole("button"))).toBe(true);
  });

  it("formats cents", () => {
    render(<Money cents={-2310} />);
    expect(screen.getByText("-$23.10")).toBeInTheDocument();
  });
});
