// Height of the on-screen keyboard (or other UI) covering the bottom of the
// layout viewport, from visualViewport. iOS Safari does not resize the page
// when the keyboard opens, so sheets lift themselves by this much.
import { useEffect, useState } from "react";

export function keyboardInset(): number {
  const vv = window.visualViewport;
  if (!vv) return 0;
  return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
}

export function useKeyboardInset(enabled = true): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!enabled || !vv) return;
    const update = () => {
      setInset(keyboardInset());
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [enabled]);
  return inset;
}
