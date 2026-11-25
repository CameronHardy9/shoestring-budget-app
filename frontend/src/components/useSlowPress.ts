// A slow press on a control that must not take focus (keepFocus buttons and
// the chips). iOS and Android send no mouse events and no click after a long
// touch, so something has to make the press happen. React Aria does it 80 ms
// after the finger lifts, but focuses the control first, which closes the
// phone keyboard; this runs just before that, without moving focus.
//
// A normal tap's own click arrives first (iOS delays it by about 32 ms) and
// cancels this. A scroll cancels the pointer, so it never presses anything.
import { useEffect, useRef, type PointerEvent } from "react";

/** After any real click, before React Aria's 80 ms. */
export const SLOW_PRESS_WAIT_MS = 70;

function isInside(e: PointerEvent): boolean {
  const r = e.currentTarget.getBoundingClientRect();
  return (
    e.clientX >= r.left &&
    e.clientX <= r.right &&
    e.clientY >= r.top &&
    e.clientY <= r.bottom
  );
}

/** Handlers for the control; `onSlowPress` gets the control's element. */
export function useSlowPress(onSlowPress: (el: HTMLElement) => void) {
  const touching = useRef<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );
  const end = () => {
    touching.current = null;
    window.clearTimeout(timer.current);
  };
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      end();
      // VoiceOver's pointer events have zero size and the wrong target or
      // position: its click does the work.
      const virtual = e.width === 0 && e.height === 0;
      if (e.pointerType === "touch" && e.isPrimary && !virtual)
        touching.current = e.pointerId;
    },
    onPointerCancel: end,
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      if (touching.current !== e.pointerId) return;
      end();
      if (!isInside(e)) return;
      const el = e.currentTarget;
      timer.current = window.setTimeout(() => {
        onSlowPress(el);
      }, SLOW_PRESS_WAIT_MS);
    },
    onClickCapture: end,
  };
}
