// Single-choice chips: an ARIA radio group built on plain buttons, styled as
// 44 px chips for thumbs.
//
// Not React Aria's RadioGroup, because its radios take focus on every tap and
// there is no way to turn that off: on an iPhone the focused text field blurs,
// and even a hand-back in the same task makes the keyboard and caret flicker.
// Here a tap made while a text field has focus moves no focus at all (no
// focusout, no focusin). Otherwise it follows React Aria's radio behaviour:
//  - one tab stop: the selected chip, or with nothing selected the first chip
//    going forwards and the last going backwards;
//  - arrow keys move and select, wrapping at the ends; Space selects; Enter
//    selects a chip that isn't, and on the selected one submits the form;
//  - a tap with no text field focused, and a screen reader's activation (a
//    click with no mouse press before it), focus the chip.
// ChipGroup.test.tsx runs the same keyboard cases against React Aria's.
import {
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { cx } from "./cx.ts";
import { Icon } from "./Icon.tsx";
import { isTextEntry } from "./text-entry.ts";
import { useSlowPress } from "./useSlowPress.ts";

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

const STEP: Partial<Record<string, 1 | -1>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

function isTyping(): boolean {
  return isTextEntry(document.activeElement);
}

/** Turns the events on a chip into one `onTap(chip, fromScreenReader)`. */
function useTap(onTap: (chip: HTMLElement, virtual: boolean) => void) {
  const sawMouseDown = useRef(false);
  const slowPress = useSlowPress((chip) => {
    onTap(chip, false);
  });
  return {
    ...slowPress,
    // The default action of mousedown is what moves focus. Only cancelled
    // while typing: otherwise the chip takes focus as any radio would.
    onMouseDown: (e: MouseEvent<HTMLElement>) => {
      if (isTyping()) e.preventDefault();
      // Only a main-button press gets a click, and only if it is released on
      // the chip; otherwise the next screen-reader click must still count as
      // one. Decided by where the release lands, never by timing: a real tap
      // taken for a screen reader's would move focus off the text field.
      sawMouseDown.current = e.button === 0;
      const chip = e.currentTarget;
      window.addEventListener(
        "mouseup",
        (up) => {
          if (!(up.target instanceof Node && chip.contains(up.target)))
            sawMouseDown.current = false;
        },
        { capture: true, once: true },
      );
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      const virtual = !sawMouseDown.current;
      sawMouseDown.current = false;
      onTap(e.currentTarget, virtual);
    },
  };
}

function ChipButton({
  chip,
  selected,
  tabbable,
  onSelect,
  onFocus,
  onKeyDown,
}: {
  chip: Chip;
  selected: boolean;
  tabbable: boolean;
  onSelect: () => void;
  onFocus: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const tap = useTap((el, virtual) => {
    if (virtual || !isTyping()) el.focus({ preventScroll: true });
    onSelect();
  });
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={tabbable ? 0 : -1}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      {...tap}
      className={cx(
        "inline-flex min-h-touch cursor-pointer items-center rounded-[calc(var(--spacing-touch)/2)] border px-4 py-1 text-base select-none",
        // No double-tap zoom, so no delay before the click. Not
        // touch-manipulation: in Safari that loses pointercancel on scroll.
        "touch-pan-x touch-pan-y touch-pinch-zoom",
        selected
          ? "border-brand bg-brand-soft text-brand-strong"
          : "border-line-strong bg-surface text-fg",
      )}
    >
      {/* Every chip is as big as it is when selected, so selecting one never
          rewraps the chips or moves the sheet. The invisible ::after holds
          that size (bold label, plus the check's 16 px and gap) in the same
          grid cell as the visible label. It is a pseudo-element, and hidden,
          so the label isn't repeated in the DOM or the accessible name. */}
      <span
        data-label={chip.label}
        className={cx(
          "grid min-w-0 items-center wrap-anywhere *:col-start-1 *:row-start-1",
          "after:invisible after:col-start-1 after:row-start-1 after:pl-[calc(16px+0.375rem)] after:text-left after:font-semibold after:content-[attr(data-label)]",
        )}
      >
        {selected ? (
          <span className="flex min-w-0 items-center gap-1.5 text-left font-semibold">
            <Icon name="check" size={16} className="shrink-0" />
            <span className="min-w-0">{chip.label}</span>
          </span>
        ) : (
          <span className="min-w-0 text-center">{chip.label}</span>
        )}
      </span>
    </button>
  );
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
  const labelId = useId();
  const errorId = useId();
  const rowRef = useRef<HTMLDivElement>(null);
  // Which chip last had focus, while the group has it: the tab stop when
  // nothing is selected.
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const has = (id: string | null) => chips.some((c) => c.id === id);
  const stop = has(value) ? value : has(focusedId) ? focusedId : null;
  const isTabStop = (i: number) =>
    stop === null ? i === 0 || i === chips.length - 1 : chips[i]?.id === stop;

  const select = (id: string) => {
    if (id !== value) onChange(id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, at: number) => {
    if (e.key === "Enter") {
      // Not selected yet: the button's own click selects it.
      if (chips[at]?.id !== value && !e.repeat) return;
      e.preventDefault();
      if (!e.repeat) e.currentTarget.form?.requestSubmit();
      return;
    }
    const step = STEP[e.key];
    if (!step || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const next = (at + step + chips.length) % chips.length;
    const chip = chips[next];
    if (!chip) return;
    const radios =
      rowRef.current?.querySelectorAll<HTMLElement>("[role=radio]");
    radios?.[next]?.focus();
    select(chip.id);
  };

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelId}
      aria-invalid={errorMessage !== undefined ? true : undefined}
      aria-describedby={errorMessage ? errorId : undefined}
      onBlur={(e: FocusEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocusedId(null);
      }}
      className={cx("flex flex-col gap-2", className)}
    >
      <span
        id={labelId}
        className={hideLabel ? "sr-only" : "text-sm font-medium text-fg"}
      >
        {label}
      </span>
      <div ref={rowRef} className="flex flex-wrap gap-2">
        {chips.map((chip, i) => (
          <ChipButton
            key={chip.id}
            chip={chip}
            selected={chip.id === value}
            tabbable={isTabStop(i)}
            onSelect={() => {
              select(chip.id);
            }}
            onFocus={() => {
              setFocusedId(chip.id);
            }}
            onKeyDown={(e) => {
              onKeyDown(e, i);
            }}
          />
        ))}
      </div>
      {errorMessage ? (
        <p id={errorId} className="text-sm text-danger">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
