// What `keepFocus` means for a React Aria button: a tap or click leaves focus
// where it is (in the field being typed in), so the phone keyboard stays up.
//  - Cancelling mousedown's default stops a tap or click moving focus.
//  - A slow press is clicked here, before React Aria focuses the button.
// Keyboard and screen-reader activation use neither, so they are unchanged.
import { useSlowPress } from "./useSlowPress.ts";
import type { MouseEvent, MouseEventHandler } from "react";

export function useKeepFocus(
  enabled: boolean,
  onMouseDown?: MouseEventHandler<HTMLElement>,
) {
  const slowPress = useSlowPress((el) => {
    el.click();
  });
  if (!enabled) return onMouseDown ? { onMouseDown } : {};
  return {
    ...slowPress,
    onMouseDown: (e: MouseEvent<HTMLElement>) => {
      onMouseDown?.(e);
      e.preventDefault();
    },
  };
}
