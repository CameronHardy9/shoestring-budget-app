// Buttons on React Aria (press handling, focus-visible, disabled semantics).
// Every size is at least the 44 px touch target.
//
// Visual options are props, and `className` is for layout only (width, margin,
// flex, self-alignment, shadow). Tailwind orders utilities by property, not by
// their position in the class attribute, so a className such as "px-3" or
// "text-sm" would not reliably beat the base classes here.
//
// `keepFocus` is for controls inside a sheet where the person is typing (the
// quick-add form): a tap must not move focus off the text field, or iOS
// closes the keyboard and the sheet jumps. It cancels the default action of
// mousedown (which is what moves focus on a tap or click); the press still
// fires. Keyboard and screen-reader activation never go through mousedown, so
// they are unchanged, and the button stays in the Tab order.
import type { MouseEvent, ReactNode } from "react";
import {
  Button as AriaButton,
  type ButtonProps as AriaButtonProps,
} from "react-aria-components";
import { cx } from "./cx.ts";

export type ButtonVariant =
  "primary" | "secondary" | "selected" | "ghost" | "quiet" | "danger" | "fab";
export type ButtonSize = "sm" | "md" | "lg" | "icon" | "fab";
export type ButtonShape = "rounded" | "pill";
export type ButtonAlign = "center" | "between";
export type ButtonWeight = "semibold" | "medium";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-brand text-on-brand shadow-1 data-[pressed]:bg-brand-strong",
  secondary:
    "bg-surface text-fg border border-line-strong data-[pressed]:bg-sunken",
  // A toggled-on secondary button (with aria-pressed): tint, brand border and
  // bold text, so the state never relies on colour alone.
  selected:
    "bg-brand-soft text-brand-strong border border-brand data-[pressed]:bg-sunken",
  ghost: "bg-transparent text-brand data-[pressed]:bg-brand-soft",
  quiet: "bg-transparent text-fg data-[pressed]:bg-sunken",
  danger:
    "bg-danger text-on-brand data-[pressed]:bg-danger-soft data-[pressed]:text-danger",
  // Add transaction (the phone's + and the desktop rail button): forest green
  // with white text/icon, >= 4.5:1 (tokens-contrast test). There's no darker
  // green token, so a press shrinks it instead.
  fab: "bg-fab text-on-fab shadow-1 data-[pressed]:scale-95",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "min-h-touch px-3 text-sm gap-1.5",
  md: "min-h-touch px-4 text-base gap-2",
  lg: "min-h-13 px-5 text-lg gap-2",
  icon: "size-touch",
  fab: "size-15",
};

const SHAPES: Record<ButtonShape, string> = {
  rounded: "rounded-md",
  pill: "rounded-full",
};

const ALIGN: Record<ButtonAlign, string> = {
  center: "justify-center",
  between: "justify-between",
};

const WEIGHTS: Record<ButtonWeight, string> = {
  semibold: "font-semibold",
  medium: "font-medium",
};

export interface ButtonProps extends Omit<
  AriaButtonProps,
  "className" | "children"
> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  shape?: ButtonShape;
  align?: ButtonAlign;
  weight?: ButtonWeight;
  /**
   * A tap or click leaves focus where it is (e.g. in the field being typed
   * in, so the phone keyboard stays up). Keyboard focus is unaffected.
   */
  keepFocus?: boolean;
  /** Layout only: width, margin, flex, self-alignment, shadow. */
  className?: string;
  children: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  shape = "rounded",
  align = "center",
  weight = "semibold",
  keepFocus = false,
  className,
  children,
  onMouseDown,
  ...rest
}: ButtonProps) {
  const mouseDown = keepFocus
    ? (e: MouseEvent<HTMLButtonElement>) => {
        onMouseDown?.(e);
        e.preventDefault();
      }
    : onMouseDown;
  return (
    <AriaButton
      {...rest}
      {...(mouseDown ? { onMouseDown: mouseDown } : {})}
      className={cx(
        "inline-flex items-center transition-colors select-none data-[disabled]:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        SHAPES[shape],
        ALIGN[align],
        WEIGHTS[weight],
        className,
      )}
    >
      {children}
    </AriaButton>
  );
}
