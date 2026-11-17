// The one loading / empty / error pattern for data-driven views.
import { useState, type ReactNode } from "react";
import { isClientError, NetworkError } from "../api/errors.ts";
import { describeError } from "../api/messages.ts";
import { Button } from "./Button.tsx";
import { Icon, type IconName } from "./Icon.tsx";

/** Skeleton rows; announced once as "Loading…". */
export function LoadingState({
  label = "Loading…",
  rows = 3,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col gap-3"
      data-testid="loading"
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="h-16 animate-pulse rounded-lg bg-sunken"
        />
      ))}
    </div>
  );
}

/**
 * Instead of a loader when a read is paused: the device is offline and nothing
 * is cached, so TanStack Query waits for the connection instead of failing.
 * One short message at a fixed minimum height, announced politely.
 */
export function OfflineState({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="flex min-h-16 items-center gap-3 rounded-lg bg-surface px-4 py-3 text-sm text-fg shadow-1"
      data-testid="offline"
    >
      <Icon name="alert" size={18} className="shrink-0 text-fg-muted" />
      <p>{message}</p>
    </div>
  );
}

/**
 * The slot for a list that has tappable rows below it, while the list has no
 * data. Before those rows appear: a skeleton, or the offline message when the
 * read is paused (so the rows can appear below it, not wait forever). Once the
 * rows are on screen the slot keeps the offline box (now "back online") until
 * the list arrives, so it changes height once, after a reconnect.
 */
export function PendingSlot({
  paused,
  rowsBelowShown,
  rows,
  offlineMessage,
}: {
  paused: boolean;
  rowsBelowShown: boolean;
  rows: number;
  offlineMessage: string;
}) {
  if (paused) return <OfflineState message={offlineMessage} />;
  if (rowsBelowShown) return <OfflineState message="Back online. Loading…" />;
  return <LoadingState rows={rows} />;
}

export function EmptyState({
  icon = "list",
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className="flex flex-col items-center gap-2 rounded-lg bg-surface px-6 py-10 text-center shadow-1"
      data-testid="empty"
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-brand-soft text-brand-strong">
        <Icon name={icon} size={24} />
      </span>
      <h2 className="text-lg font-semibold text-fg">{title}</h2>
      {children ? (
        <div className="max-w-sm text-sm text-fg-muted">{children}</div>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** Copyable request ID for "Copy diagnostics" (errors.md). */
export function Diagnostics({ requestId }: { requestId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
      <span>
        Reference: <span className="font-mono select-all">{requestId}</span>
      </span>
      {typeof navigator.clipboard === "undefined" ? null : (
        <Button
          variant="ghost"
          size="sm"
          onPress={() => {
            void navigator.clipboard
              .writeText(`Shoestring request ${requestId}`)
              .then(() => {
                setCopied(true);
              });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      )}
    </span>
  );
}

/** An inline error for a failed request, with retry when it can help. */
export function ErrorState({
  error,
  onRetry,
  title = "Couldn't load this",
  offlineMessage,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  /** Replaces the network-error copy where "nothing you typed was lost" doesn't apply. */
  offlineMessage?: string;
}) {
  const described = isClientError(error)
    ? describeError(error)
    : {
        message: "Something went wrong.",
        retryable: true,
        diagnostics: false,
        requestId: null,
      };
  if (offlineMessage && error instanceof NetworkError)
    described.message = offlineMessage;
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg bg-danger-soft px-4 py-4 text-sm"
      data-testid="error"
    >
      <p className="flex items-center gap-2 font-semibold text-danger">
        <Icon name="alert" size={18} />
        {title}
      </p>
      <p className="text-fg">{described.message}</p>
      {described.diagnostics && described.requestId ? (
        <Diagnostics requestId={described.requestId} />
      ) : null}
      {onRetry && described.retryable ? (
        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          onPress={onRetry}
        >
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** An inline message for a failed write (kept next to the form, input kept). */
export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  const described = isClientError(error)
    ? describeError(error)
    : { message: "Something went wrong.", diagnostics: false, requestId: null };
  return (
    <div
      role="alert"
      className="flex gap-2 rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger"
      data-testid="form-error"
    >
      <Icon name="alert" size={18} className="mt-px shrink-0" />
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">{described.message}</span>
        {described.diagnostics && described.requestId ? (
          <Diagnostics requestId={described.requestId} />
        ) : null}
      </div>
    </div>
  );
}
