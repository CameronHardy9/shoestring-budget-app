// Single-choice chips (React Aria RadioGroup): a real radio group for screen
// readers and keyboards, styled as 44 px chips for thumbs.
//
// `keepTextFocus` (forms with a text field, like quick-add): React Aria moves
// focus to the chip's hidden radio on every tap, and iOS closes the keyboard
// when a text field loses focus. With this on, a real tap that started while
// a text field had focus hands focus straight back to that field (in the same
// task, so the keyboard stays up); the chip is still selected. Keyboard (Tab,
// arrows) and screen-reader activation (zero-size pointer events, or none)
// are left alone, so they focus the radio as usual.
import {
  useEffect,
  useRef,
  type FocusEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
} from "react-aria-components";
import { cx } from "./cx.ts";
import { isTextEntry } from "./text-entry.ts";
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
  /** A tap on a chip leaves focus in the text field that had it. */
  keepTextFocus?: boolean;
  className?: string;
}

/**
 * Pointer events a screen reader makes up: VoiceOver's have zero size,
 * TalkBack's are a 1x1 "mouse" with no pressure (Android only, as desktop
 * Safari reports pressure 0 for a real mouse). React Aria uses the same test.
 */
function isVirtualPointer(e: PointerEvent): boolean {
  if (e.width === 0 && e.height === 0) return true;
  return (
    /Android/i.test(navigator.userAgent) &&
    e.width === 1 &&
    e.height === 1 &&
    e.pressure === 0 &&
    e.detail === 0 &&
    e.pointerType === "mouse"
  );
}

interface Kept {
  field: HTMLElement | null;
  /** Ends the document listener that drops a stale field. */
  listeners: AbortController | null;
}

function forget(kept: Kept) {
  kept.field = null;
  kept.listeners?.abort();
  kept.listeners = null;
}

/**
 * Remembers the text field that had focus when a tap began in the group, and
 * puts focus back there when the tap moves it to one of the group's radios.
 * Handlers for the element that wraps the radios.
 */
function useKeepTextFocus(enabled: boolean) {
  const ref = useRef<Kept>({ field: null, listeners: null });
  useEffect(() => {
    const kept = ref.current;
    return () => {
      forget(kept);
    };
  }, []);
  if (!enabled) return {};
  return {
    onPointerDownCapture: (e: ReactPointerEvent) => {
      const kept = ref.current;
      forget(kept);
      if (isVirtualPointer(e.nativeEvent)) return;
      const active = document.activeElement;
      if (!isTextEntry(active)) return;
      kept.field = active;
      // A tap that never reaches a chip (dragged off, released elsewhere)
      // must not leave a field behind for a later Tab or arrow key.
      const listeners = new AbortController();
      kept.listeners = listeners;
      document.addEventListener(
        "keydown",
        () => {
          forget(kept);
        },
        { capture: true, signal: listeners.signal },
      );
    },
    onPointerCancelCapture: () => {
      forget(ref.current);
    },
    // React Aria selects and focuses on click: drop the field once that click
    // has been handled, whether or not focus moved.
    onClickCapture: () => {
      const kept = ref.current;
      if (kept.field)
        setTimeout(() => {
          forget(kept);
        }, 0);
    },
    onFocusCapture: (e: FocusEvent) => {
      const kept = ref.current;
      const field = kept.field;
      const target = e.target;
      if (
        !field ||
        !(target instanceof HTMLInputElement) ||
        target.type !== "radio"
      )
        return;
      forget(kept);
      // After React Aria's own focus handling, in the same task: WebKit keeps
      // the keyboard up when focus returns to a text field this quickly.
      queueMicrotask(() => {
        if (field.isConnected) field.focus({ preventScroll: true });
      });
    },
  };
}

export function ChipGroup({
  label,
  hideLabel = false,
  chips,
  value,
  onChange,
  errorMessage,
  keepTextFocus = false,
  className,
}: ChipGroupProps) {
  const keep = useKeepTextFocus(keepTextFocus);
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
      <div className="flex flex-wrap gap-2" {...keep}>
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
