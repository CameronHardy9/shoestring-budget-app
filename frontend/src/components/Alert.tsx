// Inline status message. role="alert" for errors (announced at once), "status"
// for everything else (announced politely). Always text plus an icon.
import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import { Icon } from "./Icon.tsx";

export type AlertTone = "danger" | "warning" | "success" | "info";

const TONES: Record<AlertTone, string> = {
  danger: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
  success: "bg-success-soft text-success",
  info: "bg-brand-soft text-brand-strong",
};

export interface AlertProps {
  tone: AlertTone;
  children: ReactNode;
  /** Extra line below the message, e.g. a request ID for "Copy diagnostics". */
  detail?: ReactNode;
  className?: string;
}

export function Alert({ tone, children, detail, className }: AlertProps) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cx(
        "flex gap-2 rounded-md px-3 py-2.5 text-sm",
        TONES[tone],
        className,
      )}
    >
      <Icon
        name={tone === "success" ? "check" : "alert"}
        size={18}
        className="mt-px shrink-0"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{children}</span>
        {detail ? <span className="text-fg-muted">{detail}</span> : null}
      </div>
    </div>
  );
}
