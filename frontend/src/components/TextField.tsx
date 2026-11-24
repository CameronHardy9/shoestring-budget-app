// Labelled text input on React Aria: visible label, description and error
// wired with aria-describedby / aria-invalid. Text is 16 px so iOS never zooms.
import type { ReactNode, Ref } from "react";
import {
  FieldError,
  Input,
  Label,
  Text,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
} from "react-aria-components";
import { cx } from "./cx.ts";

export interface TextFieldProps extends Omit<
  AriaTextFieldProps,
  "className" | "children"
> {
  label: string;
  description?: string | undefined;
  /** Server or client error message; marks the field invalid. */
  errorMessage?: string | undefined;
  placeholder?: string | undefined;
  /** Passed to the <input> (React Aria's TextField does not forward these). */
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  spellCheck?: "true" | "false";
  min?: string;
  max?: string;
  /** Rendered inside the field's right edge (e.g. a show-password button). */
  trailing?: ReactNode;
  /** The <input> itself, e.g. to move focus to it. */
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
}

export function TextField({
  label,
  description,
  errorMessage,
  placeholder,
  trailing,
  className,
  autoCapitalize,
  spellCheck,
  min,
  max,
  inputRef,
  ...rest
}: TextFieldProps) {
  const inputProps = {
    ...(placeholder !== undefined ? { placeholder } : {}),
    ...(autoCapitalize !== undefined ? { autoCapitalize } : {}),
    ...(spellCheck !== undefined ? { spellCheck } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  };
  return (
    <AriaTextField
      {...rest}
      isInvalid={Boolean(errorMessage)}
      className={cx("flex flex-col gap-1.5", className)}
    >
      <Label className="text-sm font-medium text-fg">{label}</Label>
      <div className="relative flex items-center">
        <Input
          {...inputProps}
          {...(inputRef ? { ref: inputRef } : {})}
          className={cx(
            "min-h-touch w-full rounded-md border border-line-strong bg-surface pl-3 text-base text-fg",
            "placeholder:text-fg-muted data-[invalid]:border-danger",
            trailing ? "pr-20" : "pr-3",
          )}
        />
        {trailing ? <div className="absolute right-1">{trailing}</div> : null}
      </div>
      {description ? (
        <Text slot="description" className="text-sm text-fg-muted">
          {description}
        </Text>
      ) : null}
      <FieldError className="flex items-center gap-1 text-sm text-danger">
        {errorMessage}
      </FieldError>
    </AriaTextField>
  );
}
