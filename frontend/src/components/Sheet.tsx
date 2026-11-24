// Bottom sheet on phones, centred dialog on wide screens. React Aria Modal:
// focus is trapped and restored, Escape and a tap on the scrim close it, and
// the page behind is inert. `bottomInset` lifts the sheet above the on-screen
// keyboard (the app feeds it from visualViewport; the preview from a mock).
// While lifted, its height is also capped to the visible space above the
// keyboard, so the top (title, amount) never goes off screen: the content
// scrolls inside instead.
import type { ReactNode } from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { Button } from "./Button.tsx";
import { useKeyboardInset } from "./useKeyboardInset.ts";
import { Icon } from "./Icon.tsx";

export interface SheetProps {
  title: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  /** Fixed inset (preview); by default follows the on-screen keyboard. */
  bottomInset?: number;
  "data-testid"?: string;
}

/** Room between the top of the screen (below the notch) and a lifted sheet. */
const TOP_GAP_PX = 8;

/**
 * The dialog's max-height while a keyboard (inset > 0) covers the bottom:
 * no taller than usual (85dvh), and no taller than the visible height minus
 * the status bar / notch area and a small gap. Undefined with no keyboard, so
 * the class's 85dvh applies and the sheet looks exactly as before.
 *
 * Applied through CSSOM (React's `style` prop), which the CSP allows; there
 * is never a `style=""` attribute in the markup.
 */
export function liftedMaxHeight(
  inset: number,
  visibleHeight: number,
): string | undefined {
  if (inset <= 0) return undefined;
  const room = Math.max(0, Math.round(visibleHeight));
  return `min(85dvh, calc(${String(room)}px - env(safe-area-inset-top) - ${String(TOP_GAP_PX)}px))`;
}

/**
 * Height of the area the person can see above the keyboard. With a real
 * keyboard that is the visual viewport (iOS may also pan it, which moves the
 * sheet's bottom but not this); with a fixed inset (preview) the window less
 * the inset.
 */
function visibleHeight(inset: number, followsKeyboard: boolean): number {
  const vv = window.visualViewport;
  if (followsKeyboard && vv) return vv.height;
  return window.innerHeight - inset;
}

export function Sheet({
  title,
  isOpen,
  onOpenChange,
  children,
  bottomInset,
  ...rest
}: SheetProps) {
  const keyboard = useKeyboardInset(isOpen && bottomInset === undefined);
  const inset = bottomInset ?? keyboard;
  // Read while rendering: the inset changes (and so re-renders) whenever the
  // keyboard opens, closes or changes height, which is what moves the top.
  const maxHeight = liftedMaxHeight(
    inset,
    visibleHeight(inset, bottomInset === undefined),
  );
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="fixed inset-0 z-40 flex items-end justify-center bg-scrim lg:items-center"
    >
      <Modal
        className="w-full max-w-lg rounded-t-xl bg-surface shadow-3 lg:rounded-xl"
        style={{ marginBottom: inset }}
      >
        <Dialog
          className="flex max-h-[85dvh] flex-col outline-none"
          {...(maxHeight ? { style: { maxHeight } } : {})}
          data-testid={rest["data-testid"]}
        >
          <div
            aria-hidden="true"
            className="mx-auto mt-2 h-1 w-10 rounded-full bg-line-strong lg:hidden"
          />
          <div className="flex items-center justify-between px-4 pt-1">
            <Heading slot="title" className="text-lg font-semibold text-fg">
              {title}
            </Heading>
            <Button
              variant="quiet"
              size="icon"
              slot="close"
              aria-label="Close"
              className="-mr-2"
            >
              <Icon name="close" />
            </Button>
          </div>
          <div className="overflow-y-auto px-4 pb-4">{children}</div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
