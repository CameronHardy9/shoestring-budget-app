// Single-choice segmented control (React Aria ToggleButtonGroup): one tab stop,
// arrow keys move between options, the selection is never empty.
import type { Key } from "react-aria-components";
import { ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { cx } from "./cx.ts";

export interface SegmentedOption<K extends string> {
  id: K;
  label: string;
}

export interface SegmentedControlProps<K extends string> {
  /** Accessible name of the group. */
  label: string;
  options: readonly SegmentedOption<K>[];
  value: K;
  onChange: (value: K) => void;
  className?: string;
}

export function SegmentedControl<K extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: SegmentedControlProps<K>) {
  return (
    <ToggleButtonGroup
      aria-label={label}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys: Set<Key>) => {
        const [next] = [...keys];
        const match = options.find((o) => o.id === next);
        if (match && match.id !== value) onChange(match.id);
      }}
      className={cx(
        "grid auto-cols-fr grid-flow-col gap-1 rounded-md bg-sunken p-1",
        className,
      )}
    >
      {options.map((option) => (
        <ToggleButton
          key={option.id}
          id={option.id}
          className={cx(
            "min-h-10 rounded-sm px-3 text-sm font-semibold text-fg-muted",
            // The selected segment has a line-strong ring (>= 3:1 against the
            // track), not just a lighter fill (WCAG 1.4.11).
            "data-[selected]:bg-surface data-[selected]:text-fg data-[selected]:shadow-1",
            "data-[selected]:ring-1 data-[selected]:ring-line-strong",
          )}
        >
          {option.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
