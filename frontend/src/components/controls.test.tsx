import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetBar, usedFraction } from "./BudgetBar.tsx";
import { Button } from "./Button.tsx";
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

// iOS and Android send no mouse events or click after a slow press. React Aria
// then focuses the button and clicks it itself, which would close the keyboard.
describe("keepFocus on a slow touch press", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const finger = {
    pointerType: "touch",
    isPrimary: true,
    pointerId: 7,
    width: 20,
    height: 20,
  };
  const off = { ...finger, clientX: 500, clientY: 500 };
  const controls = [
    ["Button", "button", "Note"],
    ["SegmentedControl", "radio", "Received"],
  ] as const;

  function setUp(
    role: "button" | "radio",
    name: string,
    {
      keepFocus = true,
      type = "button",
    }: { keepFocus?: boolean; type?: "button" | "submit" } = {},
  ) {
    const onPress = vi.fn();
    const onSubmit = vi.fn();
    const view = render(
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <input aria-label="Amount" />
        <Button keepFocus={keepFocus} type={type} onPress={onPress}>
          Note
        </Button>
        <SegmentedControl
          label="Type"
          value="outflow"
          onChange={onPress}
          keepFocus={keepFocus}
          options={[
            { id: "outflow", label: "Spent" },
            { id: "inflow", label: "Received" },
          ]}
        />
      </form>,
    );
    const el = screen.getByRole(role, { name });
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 100, 44),
    );
    const amount = screen.getByRole("textbox", { name: "Amount" });
    amount.focus();
    const onBlur = vi.fn();
    amount.addEventListener("focusout", onBlur);
    return { ...view, el, amount, onPress, onSubmit, onBlur };
  }
  const wait = () => {
    act(() => {
      vi.advanceTimersByTime(1000);
    });
  };
  const slowPress = (el: HTMLElement) => {
    fireEvent.pointerDown(el, finger);
    wait();
    fireEvent.pointerUp(el, finger);
    wait();
  };

  it.each(controls)(
    "%s: presses once and focus never leaves the field",
    (_component, role, name) => {
      const { el, amount, onPress, onBlur } = setUp(role, name);
      slowPress(el);
      expect(onPress).toHaveBeenCalledOnce();
      expect(onBlur).not.toHaveBeenCalled();
      expect(amount).toHaveFocus();
    },
  );

  it("a submit button submits once", () => {
    const { el, onSubmit, onPress, onBlur } = setUp("button", "Note", {
      type: "submit",
    });
    slowPress(el);
    expect(onPress).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onBlur).not.toHaveBeenCalled();
  });

  it.each(controls)(
    "%s: a normal tap still presses exactly once",
    (_component, role, name) => {
      const { el, onPress, onBlur } = setUp(role, name);
      fireEvent.pointerDown(el, finger);
      fireEvent.pointerUp(el, finger);
      fireEvent.mouseDown(el);
      fireEvent.mouseUp(el);
      fireEvent.click(el, { detail: 1 });
      wait();
      expect(onPress).toHaveBeenCalledOnce();
      expect(onBlur).not.toHaveBeenCalled();
    },
  );

  it.each(controls)(
    "%s: a late click after a slow press does not press again",
    (_component, role, name) => {
      const { el, onPress } = setUp(role, name);
      slowPress(el);
      fireEvent.mouseDown(el);
      fireEvent.mouseUp(el);
      fireEvent.click(el, { detail: 1 });
      wait();
      expect(onPress).toHaveBeenCalledOnce();
    },
  );

  it.each(controls)(
    "%s: a scroll or a lift elsewhere presses nothing",
    (_component, role, name) => {
      const { el, onPress } = setUp(role, name);
      fireEvent.pointerDown(el, finger);
      fireEvent.pointerCancel(el, finger);
      wait();
      fireEvent.pointerDown(el, finger);
      fireEvent.pointerUp(document.body, off);
      wait();
      expect(onPress).not.toHaveBeenCalled();
    },
  );

  it("drops a pending press when the control goes away", () => {
    const { el, onPress, unmount } = setUp("button", "Note");
    fireEvent.pointerDown(el, finger);
    fireEvent.pointerUp(el, finger);
    unmount();
    wait();
    expect(onPress).not.toHaveBeenCalled();
  });

  it.each(controls)(
    "%s without keepFocus is React Aria's as before: pressed and focused",
    (_component, role, name) => {
      const { el, onPress, onBlur } = setUp(role, name, { keepFocus: false });
      slowPress(el);
      expect(onPress).toHaveBeenCalledOnce();
      expect(onBlur).toHaveBeenCalled();
      expect(el).toHaveFocus();
    },
  );
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
