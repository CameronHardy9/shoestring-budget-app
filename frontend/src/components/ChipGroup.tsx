// Single-choice chips (React Aria RadioGroup): a real radio group for screen
// readers and keyboards, styled as 44 px chips for thumbs.
import {
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
} from "react-aria-components";
import { cx } from "./cx.ts";
import { Icon } from "./Icon.tsx";

export interface Chip {
  id: string;
  label: string;
}

export interface ChipGroupProps {
  label: string;
  /** Hide the label visually (it stays the group's accessible name). */
  hideLabel?: boolean;
  chips: readonly Chip[];
  value: string | null;
  onChange: (id: string) => void;
  errorMessage?: string;
  className?: string;
}

export function ChipGroup({
  label,
  hideLabel = false,
  chips,
  value,
  onChange,
  errorMessage,
  className,
}: ChipGroupProps) {
  return (
    <RadioGroup
      value={value}
      onChange={onChange}
      isInvalid={errorMessage !== undefined}
      className={cx("flex flex-col gap-2", className)}
    >
      <Label className={hideLabel ? "sr-only" : "text-sm font-medium text-fg"}>
        {label}
      </Label>
      <div className="flex flex-wrap gap-2">
        {chips.map((chip) => (
          <RadioField key={chip.id} value={chip.id}>
            <RadioButton
              className={cx(
                "inline-flex min-h-touch cursor-pointer items-center gap-1.5 rounded-full border px-4 text-base",
                "border-line-strong bg-surface text-fg",
                "data-[selected]:border-brand data-[selected]:bg-brand-soft data-[selected]:font-semibold data-[selected]:text-brand-strong",
              )}
            >
              {({ isSelected }) => (
                <>
                  {isSelected ? <Icon name="check" size={16} /> : null}
                  {chip.label}
                </>
              )}
            </RadioButton>
          </RadioField>
        ))}
      </div>
      {errorMessage ? (
        <p className="text-sm text-danger">{errorMessage}</p>
      ) : null}
    </RadioGroup>
  );
}
