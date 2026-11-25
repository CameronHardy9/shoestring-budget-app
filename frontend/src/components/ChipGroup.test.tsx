import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type SyntheticEvent } from "react";
import {
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
} from "react-aria-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxeViolations } from "../test/axe.ts";
import { ChipGroup } from "./ChipGroup.tsx";

const chips = [
  { id: "a", label: "Groceries" },
  { id: "b", label: "Dining out" },
  { id: "c", label: "Transport" },
];

interface HarnessProps {
  initial?: string | null;
  onChange?: (id: string) => void;
  onSubmit?: () => void;
  errorMessage?: string;
}

/** A form as in quick-add: a text field, the chips, then a button. */
function makeHarness(
  Group: (props: {
    value: string | null;
    onChange: (id: string) => void;
    errorMessage?: string;
  }) => React.ReactNode,
) {
  return function Harness({
    initial = null,
    onChange,
    onSubmit,
    errorMessage,
  }: HarnessProps) {
    const [value, setValue] = useState(initial);
    return (
      <form
        onSubmit={(e: SyntheticEvent) => {
          e.preventDefault();
          onSubmit?.();
        }}
      >
        <input aria-label="Amount" inputMode="decimal" />
        <Group
          value={value}
          onChange={(id) => {
            setValue(id);
            onChange?.(id);
          }}
          {...(errorMessage === undefined ? {} : { errorMessage })}
        />
        <button type="submit">Save</button>
      </form>
    );
  };
}

const Ours = makeHarness((props) => (
  <ChipGroup label="Category" chips={chips} {...props} />
));

/** What the chips were built on before, as the reference for the keyboard. */
const ReactAria = makeHarness(({ value, onChange }) => (
  <RadioGroup value={value} onChange={onChange}>
    <Label>Category</Label>
    {chips.map((chip) => (
      <RadioField key={chip.id} value={chip.id}>
        <RadioButton>{chip.label}</RadioButton>
      </RadioField>
    ))}
  </RadioGroup>
));

const amount = () => screen.getByRole("textbox", { name: "Amount" });
const save = () => screen.getByRole("button", { name: "Save" });
const radio = (name: string) => screen.getByRole("radio", { name });

/** Every focus event from now on, as "type name". */
function focusLog(): string[] {
  const log: string[] = [];
  const add = (e: Event) => {
    log.push(`${e.type} ${(e.target as Element).textContent || "field"}`);
  };
  for (const type of ["focusin", "focusout", "focus", "blur"])
    document.addEventListener(type, add, {
      capture: true,
      signal: stop.signal,
    });
  return log;
}
let stop: AbortController;
beforeEach(() => {
  stop = new AbortController();
});
afterEach(() => {
  stop.abort();
});

describe.each([
  ["ChipGroup", Ours],
  ["React Aria RadioGroup (reference)", ReactAria],
])("keyboard: %s", (_name, Harness) => {
  it("is one tab stop, the selected chip, in both directions", async () => {
    render(<Harness initial="b" />);
    amount().focus();
    await userEvent.tab();
    expect(radio("Dining out")).toHaveFocus();
    await userEvent.tab();
    expect(save()).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(radio("Dining out")).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(amount()).toHaveFocus();
  });

  it("with nothing selected, Tab enters at the first chip and selects nothing", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    amount().focus();
    await userEvent.tab();
    expect(radio("Groceries")).toHaveFocus();
    await userEvent.tab();
    expect(save()).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("with nothing selected, Shift+Tab enters at the last chip", async () => {
    render(<Harness />);
    save().focus();
    await userEvent.tab({ shift: true });
    expect(radio("Transport")).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(amount()).toHaveFocus();
  });

  it("arrow keys move and select, wrapping at both ends", async () => {
    const onChange = vi.fn();
    render(<Harness initial="a" onChange={onChange} />);
    amount().focus();
    await userEvent.tab();
    for (const [key, name] of [
      ["ArrowRight", "Dining out"],
      ["ArrowDown", "Transport"],
      ["ArrowRight", "Groceries"],
      ["ArrowLeft", "Transport"],
      ["ArrowUp", "Dining out"],
    ] as const) {
      await userEvent.keyboard(`{${key}}`);
      expect(radio(name)).toHaveFocus();
      expect(radio(name)).toBeChecked();
      expect(screen.getAllByRole("radio", { checked: true })).toHaveLength(1);
    }
    expect(onChange.mock.calls.flat()).toEqual(["b", "c", "a", "c", "b"]);
  });

  it("an arrow key from an unselected group selects the next chip", async () => {
    render(<Harness />);
    amount().focus();
    await userEvent.tab();
    await userEvent.keyboard("{ArrowDown}");
    expect(radio("Dining out")).toHaveFocus();
    expect(radio("Dining out")).toBeChecked();
  });

  it("Space selects the focused chip, once, and does not submit", async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness onChange={onChange} onSubmit={onSubmit} />);
    amount().focus();
    await userEvent.tab();
    await userEvent.keyboard(" ");
    expect(radio("Groceries")).toBeChecked();
    await userEvent.keyboard(" ");
    expect(onChange.mock.calls).toEqual([["a"]]);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(radio("Groceries")).toHaveFocus();
  });

  it("Enter on an unselected chip selects it", async () => {
    render(<Harness />);
    amount().focus();
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect(radio("Groceries")).toBeChecked();
    expect(radio("Groceries")).toHaveFocus();
  });

  it("Enter on the selected chip submits the form", async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness initial="b" onChange={onChange} onSubmit={onSubmit} />);
    amount().focus();
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a tap with no text field focused selects and focuses the chip", async () => {
    render(<Harness initial="a" />);
    save().focus();
    await userEvent.click(screen.getByText("Dining out"));
    expect(radio("Dining out")).toBeChecked();
    expect(radio("Dining out")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(radio("Transport")).toBeChecked();
  });

  it("a screen reader's click selects and focuses the chip", () => {
    render(<Harness initial="a" />);
    amount().focus();
    fireEvent.click(screen.getByText("Dining out"));
    expect(radio("Dining out")).toBeChecked();
    expect(radio("Dining out")).toHaveFocus();
  });
});

describe("ChipGroup Enter", () => {
  it("doesn't submit while selecting (React Aria submits first), nor on repeat", async () => {
    const onSubmit = vi.fn();
    render(<Ours onSubmit={onSubmit} />);
    amount().focus();
    await userEvent.tab();
    await userEvent.keyboard("{Enter>3/}");
    expect(radio("Groceries")).toBeChecked();
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});

describe("ChipGroup taps while typing", () => {
  it("selects with no focus event at all, every time", async () => {
    const onChange = vi.fn();
    render(<Ours initial="a" onChange={onChange} />);
    amount().focus();
    const log = focusLog();
    for (const name of ["Dining out", "Transport", "Dining out"]) {
      await userEvent.click(screen.getByText(name));
      expect(radio(name)).toBeChecked();
    }
    expect(log).toEqual([]);
    expect(amount()).toHaveFocus();
    expect(onChange.mock.calls.flat()).toEqual(["b", "c", "b"]);
  });

  it("then leaves the keyboard path alone", async () => {
    render(<Ours initial="a" />);
    amount().focus();
    await userEvent.click(screen.getByText("Dining out"));
    await userEvent.tab();
    expect(radio("Dining out")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(radio("Transport")).toBeChecked();
  });

  it("re-tapping the selected chip does nothing", async () => {
    const onChange = vi.fn();
    render(<Ours initial="b" onChange={onChange} />);
    amount().focus();
    await userEvent.click(screen.getByText("Dining out"));
    expect(onChange).not.toHaveBeenCalled();
    expect(amount()).toHaveFocus();
  });

  it("a mouse press that ends elsewhere selects nothing", async () => {
    const onChange = vi.fn();
    render(<Ours initial="a" onChange={onChange} />);
    amount().focus();
    const user = userEvent.setup();
    await user.pointer([
      { keys: "[MouseLeft>]", target: radio("Dining out") },
      { target: radio("Transport") },
      { keys: "[/MouseLeft]", target: radio("Transport") },
    ]);
    expect(onChange).not.toHaveBeenCalled();
    expect(amount()).toHaveFocus();
  });
});

describe("ChipGroup: a screen reader's click after an abandoned press", () => {
  it.each([
    ["released off the chip", 0],
    ["made with another button", 2],
  ])("still selects and focuses (press %s)", (_what, button) => {
    render(<Ours initial="a" />);
    amount().focus();
    const chip = radio("Dining out");
    fireEvent.mouseDown(chip, { button });
    fireEvent.mouseUp(button === 0 ? amount() : chip, { button });
    expect(amount()).toHaveFocus();
    fireEvent.click(chip);
    expect(chip).toBeChecked();
    expect(chip).toHaveFocus();
  });

  it("but a real tap right after one still leaves focus alone", async () => {
    render(<Ours initial="a" />);
    amount().focus();
    fireEvent.mouseDown(radio("Dining out"));
    fireEvent.mouseUp(amount());
    await userEvent.click(screen.getByText("Dining out"));
    expect(radio("Dining out")).toBeChecked();
    expect(amount()).toHaveFocus();
  });
});

// iOS and Android send no mouse events or click after a slow press, and
// cancel the pointer when a touch turns into a scroll.
describe("ChipGroup touches", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const touch = { pointerType: "touch", isPrimary: true, pointerId: 7 };
  const finger = { ...touch, width: 20, height: 20, clientX: 10, clientY: 10 };

  function setUp() {
    const onChange = vi.fn();
    render(<Ours initial="a" onChange={onChange} />);
    const chip = radio("Dining out");
    vi.spyOn(chip, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 100, 44),
    );
    amount().focus();
    return { onChange, chip, log: focusLog() };
  }
  const wait = () => {
    vi.advanceTimersByTime(1000);
  };

  it("a slow press selects, still with no focus event", () => {
    const { onChange, chip, log } = setUp();
    fireEvent.pointerDown(chip, finger);
    wait();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(chip, finger);
    wait();
    expect(onChange.mock.calls).toEqual([["b"]]);
    expect(log).toEqual([]);
  });

  it("a normal tap selects once, on the click", () => {
    const { onChange, chip, log } = setUp();
    fireEvent.pointerDown(chip, finger);
    fireEvent.pointerUp(chip, finger);
    fireEvent.mouseDown(chip);
    fireEvent.mouseUp(chip);
    fireEvent.click(chip, { detail: 1 });
    wait();
    expect(onChange.mock.calls).toEqual([["b"]]);
    expect(log).toEqual([]);
  });

  it("a scroll that starts on a chip selects nothing and is not blocked", () => {
    const { onChange, chip } = setUp();
    const down = createEvent.pointerDown(chip, finger);
    fireEvent(chip, down);
    expect(down.defaultPrevented).toBe(false);
    for (const type of ["touchStart", "touchMove"] as const) {
      const e = createEvent[type](chip);
      fireEvent(chip, e);
      expect(e.defaultPrevented).toBe(false);
    }
    fireEvent.pointerCancel(chip, finger);
    fireEvent.pointerUp(chip, finger);
    wait();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a finger lifted off the chip selects nothing", () => {
    const { onChange, chip } = setUp();
    fireEvent.pointerDown(chip, finger);
    fireEvent.pointerUp(chip, { ...finger, clientY: 200 });
    wait();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("VoiceOver's zero-size pointer events are left to its click", () => {
    const { onChange, chip } = setUp();
    fireEvent.pointerDown(chip, { ...touch, width: 0, height: 0 });
    fireEvent.pointerUp(chip, { ...touch, width: 0, height: 0 });
    wait();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(chip);
    expect(onChange.mock.calls).toEqual([["b"]]);
  });

  it("drops a pending slow press when the chips go away", () => {
    const onChange = vi.fn();
    const { unmount } = render(<Ours initial="a" onChange={onChange} />);
    const chip = radio("Dining out");
    vi.spyOn(chip, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 100, 44),
    );
    fireEvent.pointerDown(chip, finger);
    fireEvent.pointerUp(chip, finger);
    unmount();
    wait();
    expect(onChange).not.toHaveBeenCalled();
  });
});

// jsdom does no layout, so this checks what makes the width constant; the real
// geometry (chip rects and sheet top around every tap) needs a browser.
describe("ChipGroup constant size", () => {
  const sizer = (name: string) => {
    const el = radio(name).firstElementChild;
    if (!(el instanceof HTMLElement)) throw new Error("no sizer");
    return el;
  };

  it("reserves the selected size on every chip, the same before and after", async () => {
    render(<Ours initial="a" />);
    const state = () =>
      chips.map(({ label }) => [
        sizer(label).dataset.label,
        sizer(label).className,
      ]);
    const before = state();
    expect(before.map(([label]) => label)).toEqual(chips.map((c) => c.label));
    expect(sizer("Groceries").className).toContain(
      "after:content-[attr(data-label)]",
    );
    expect(sizer("Groceries").className).toContain("after:invisible");
    for (const { label } of chips) {
      await userEvent.click(screen.getByText(label));
      expect(state()).toEqual(before);
    }
  });

  it("never repeats the label in the name or the text, and has no inline style", async () => {
    const { container } = render(<Ours initial="a" />);
    for (const { label } of chips) {
      await userEvent.click(screen.getByText(label));
      for (const chip of chips) {
        expect(radio(chip.label)).toHaveAccessibleName(chip.label);
        expect(radio(chip.label).textContent).toBe(chip.label);
      }
    }
    expect(container.querySelector("[style]")).toBeNull();
  });
});

describe("ChipGroup semantics", () => {
  it("is a labelled radio group with one checked radio and no violations", async () => {
    const { container } = render(<Ours initial="a" />);
    expect(screen.getByRole("radiogroup", { name: "Category" })).toBeValid();
    expect(
      screen.getAllByRole("radio").map((r) => r.getAttribute("aria-checked")),
    ).toEqual(["true", "false", "false"]);
    await expectNoAxeViolations(container);
  });

  it("keeps the label as the accessible name when it is hidden", () => {
    render(
      <ChipGroup
        label="Category"
        hideLabel
        chips={chips}
        value={null}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("radiogroup", { name: "Category" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Category")).toHaveClass("sr-only");
  });

  it("marks the group invalid and described by its error", async () => {
    const { container, rerender } = render(
      <Ours errorMessage="Choose a category." />,
    );
    const group = screen.getByRole("radiogroup", { name: "Category" });
    expect(group).toBeInvalid();
    expect(group).toHaveAccessibleDescription("Choose a category.");
    await expectNoAxeViolations(container);
    rerender(<Ours />);
    expect(group).toBeValid();
    expect(group).not.toHaveAttribute("aria-describedby");
  });

  it("stays reachable when the selected chip is not shown", async () => {
    render(<Ours initial="gone" />);
    amount().focus();
    await userEvent.tab();
    expect(radio("Groceries")).toHaveFocus();
  });
});
