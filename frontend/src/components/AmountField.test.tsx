import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoAxeViolations } from "../test/axe.ts";
import { AMOUNT_ERROR_COPY, AmountField, amountError } from "./AmountField.tsx";

function Harness({
  onCents,
  showError = false,
}: {
  onCents: (c: number | null) => void;
  showError?: boolean;
}) {
  const [text, setText] = useState("");
  return (
    <AmountField
      label="Amount"
      value={text}
      showError={showError}
      onChange={(t, cents) => {
        setText(t);
        onCents(cents);
      }}
    />
  );
}

describe("AmountField", () => {
  it("opens the decimal keypad and reports integer cents as you type", async () => {
    const onCents = vi.fn();
    render(<Harness onCents={onCents} />);
    const input = screen.getByRole("textbox", { name: "Amount" });
    expect(input).toHaveAttribute("inputmode", "decimal");
    await userEvent.type(input, "12.5");
    expect(input).toHaveValue("12.5");
    expect(onCents).toHaveBeenLastCalledWith(1250);
    await userEvent.type(input, "55");
    expect(onCents).toHaveBeenLastCalledWith(null);
  });

  it("shows a validation message only when asked", async () => {
    const { rerender } = render(<Harness onCents={vi.fn()} />);
    expect(screen.queryByText(AMOUNT_ERROR_COPY.empty)).toBeNull();
    rerender(<Harness onCents={vi.fn()} showError />);
    expect(
      await screen.findByText(AMOUNT_ERROR_COPY.empty),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Amount" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("prefers a server message", () => {
    render(
      <AmountField
        label="Amount"
        value="5"
        onChange={vi.fn()}
        errorMessage="The splits must add up to the total."
      />,
    );
    expect(
      screen.getByText("The splits must add up to the total."),
    ).toBeInTheDocument();
  });

  it("has no serious axe violations", async () => {
    const { container } = render(
      <AmountField
        label="Amount"
        size="display"
        hideLabel
        value="42.50"
        onChange={vi.fn()}
      />,
    );
    await expectNoAxeViolations(container);
  });

  it("amountError honours limits", () => {
    expect(amountError("0", { min: 0 })).toBeNull();
    expect(amountError("0")).toBe("too_small");
  });
});
