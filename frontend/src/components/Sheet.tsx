// Bottom sheet on phones, centred dialog on wide screens. React Aria Modal:
// focus is trapped and restored, Escape and a tap on the scrim close it, and
// the page behind is inert. `bottomInset` lifts the sheet above the on-screen
// keyboard (the app feeds it from visualViewport; the preview from a mock).
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
