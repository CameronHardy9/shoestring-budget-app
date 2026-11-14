// A confirmation for destructive or far-reaching actions (alertdialog): what
// will happen, a cancel that is easy to hit, and the action itself.
import type { ReactNode } from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { Button } from "./Button.tsx";
import { FormError } from "./States.tsx";

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: "danger" | "primary";
  busy?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  children,
  confirmLabel,
  tone = "danger",
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      isDismissable={!busy}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim sm:items-center"
    >
      <Modal className="w-full max-w-md rounded-t-xl bg-surface p-5 shadow-3 sm:rounded-xl">
        <Dialog
          role="alertdialog"
          className="flex flex-col gap-4 outline-none"
          data-testid="confirm-dialog"
        >
          <Heading slot="title" className="text-lg font-semibold text-fg">
            {title}
          </Heading>
          <div className="text-base text-fg">{children}</div>
          <FormError error={error} />
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              onPress={onCancel}
              isDisabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant={tone === "danger" ? "danger" : "primary"}
              className="flex-1"
              isPending={busy}
              onPress={onConfirm}
              data-testid="confirm-action"
            >
              {confirmLabel}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
