// Money input: opens the phone's decimal keypad, keeps exactly what was typed
// (so nothing is lost on a failed save), and reports integer cents parsed by
// lib/money.ts. Never a float, never type="number" (which drops "12." and
// accepts "1e5").
import { FieldError, Input, Label, TextField } from "react-aria-components";
import {
  parseMoneyInput,
  type MoneyParseError,
  type MoneyParseOptions,
} from "../lib/money.ts";
import { cx } from "./cx.ts";

export const AMOUNT_ERROR_COPY: Record<MoneyParseError, string> = {
  empty: "Enter an amount.",
  invalid: "Use digits, like 12.50.",
  too_many_decimals: "Use at most two decimal places.",
  too_small: "Enter an amount above $0.00.",
  too_big: "The most you can enter is $1,000,000.00.",
};

export interface AmountFieldProps extends MoneyParseOptions {
  label: string;
  /** Hide the label visually; it stays the accessible name. */
  hideLabel?: boolean;
  value: string;
  /** Raw text plus the parsed cents (null while incomplete or invalid). */
  onChange: (text: string, cents: number | null) => void;
  /** Show validation (after a save attempt or blur), or a server message. */
  showError?: boolean;
  errorMessage?: string | undefined;
  size?: "display" | "row";
  autoFocus?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function amountError(
  text: string,
  options: MoneyParseOptions = {},
): MoneyParseError | null {
  const result = parseMoneyInput(text, options);
  return result.ok ? null : result.error;
}

export function AmountField({
  label,
  hideLabel = false,
  value,
  onChange,
  showError = false,
  errorMessage,
  size = "row",
  autoFocus,
  className,
  min,
  max,
  ...rest
}: AmountFieldProps) {
  const options: MoneyParseOptions = {
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  };
  const localError = amountError(value, options);
  const message =
    errorMessage ??
    (showError && localError ? AMOUNT_ERROR_COPY[localError] : undefined);
  const display = size === "display";
  return (
    <TextField
      value={value}
      onChange={(text) => {
        const result = parseMoneyInput(text, options);
        onChange(text, result.ok ? result.cents : null);
      }}
      isInvalid={message !== undefined}
      {...(autoFocus !== undefined ? { autoFocus } : {})}
      className={cx(
        "flex flex-col gap-1",
        display && "items-center",
        className,
      )}
    >
      <Label
        className={hideLabel ? "sr-only" : "text-sm font-medium text-fg-muted"}
      >
        {label}
      </Label>
      <div
        className={cx(
          "flex items-baseline gap-0.5 text-fg",
          display
            ? "max-w-full justify-center"
            : "rounded-md border border-line-strong bg-surface px-3",
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            "tabular text-fg-muted",
            display ? "text-3xl" : "text-base",
          )}
        >
          $
        </span>
        <Input
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="done"
          placeholder="0.00"
          {...(rest["data-testid"]
            ? { "data-testid": rest["data-testid"] }
            : {})}
          // The display amount grows with what is typed, so "$" stays next to
          // the digits (CSSOM style: allowed by the CSP, unlike style="").
          {...(display
            ? {
                style: {
                  width: `${String(Math.max(value.length, 4) + 0.5)}ch`,
                },
              }
            : {})}
          className={cx(
            "tabular min-w-0 bg-transparent text-fg placeholder:text-fg-muted focus-visible:outline-none",
            display
              ? "text-left text-display font-semibold"
              : "min-h-touch w-full text-right text-base",
          )}
        />
      </div>
      <FieldError className="text-sm text-danger">{message}</FieldError>
    </TextField>
  );
}
