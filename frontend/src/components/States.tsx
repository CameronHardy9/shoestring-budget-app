// The one loading / empty / error pattern for data-driven views.
import { useState, type ReactNode } from "react";
import { isClientError, NetworkError } from "../api/errors.ts";
import { describeError } from "../api/messages.ts";
import { Button } from "./Button.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { LACE_SIZE, LaceLoader } from "./LaceLoader.tsx";
import { useInterruptPageLoader, usePageLoad } from "./page-loader.ts";

/**
 * The min-height `rows` reserves for an inline loader: what the old skeleton's
 * rows took (each h-16, 4rem, with gap-3, 0.75rem, between them).
 */
export function loadingMinHeight(rows: number): string {
  const n = Math.max(1, Math.round(rows));
  return `${String(n * 4 + (n - 1) * 0.75)}rem`;
}

/**
 * Where a loader goes. "viewport" (the default, every page-level load): the
 * 96 px lace in the middle of the viewport (owner ruling 2026-11-24), drawn by
 * the one app-level <PageLoader> for every page load in a row, as one
 * animation that always finishes its cycle (PageLoader.tsx, page-loader.ts).
 * In the page it is an empty marker that takes no space, so it reserves
 * nothing and pushes nothing (the loading region is the last thing on screen
 * anyway: see "Nothing moves under a finger" in frontend/CLAUDE.md). "inline":
 * the 56 px lace in a `rows`-tall box in the flow, at once and gone as soon as
 * the data is, for a load inside a sheet (the page behind is covered) or in a
 * section below content that has already loaded (the middle of the viewport
 * may be that content).
 */
export type LoaderPlacement =
  | { placement?: "viewport"; rows?: never }
  | {
      placement: "inline";
      /** Height hint, in old skeleton rows. */
      rows?: number;
    };

/**
 * The lace loader; announced once as the label (screen-reader only: the
 * screen's heading already says where you are). A viewport loader's label is
 * the page loader session's status text if it is the newest load when the
 * lace appears; later loads in the same session aren't announced again.
 */
export function LoadingState({
  label = "Loading…",
  ...where
}: { label?: string } & LoaderPlacement) {
  if (where.placement === "inline") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center justify-center"
        style={{ minHeight: loadingMinHeight(where.rows ?? 3) }}
        data-testid="loading"
        data-placement="inline"
      >
        <span className="sr-only">{label}</span>
        <LaceLoader size={LACE_SIZE} />
      </div>
    );
  }
  return <PageLoadSlot label={label} />;
}

/** Where a page-level load is, in the page; the lace is <PageLoader>'s. */
function PageLoadSlot({ label }: { label: string }) {
  usePageLoad(label);
  return <div hidden data-testid="loading-slot" data-label={label} />;
}

/**
 * Instead of a loader when a read is paused: the device is offline and nothing
 * is cached, so TanStack Query waits for the connection instead of failing.
 * One short message at a fixed minimum height, announced politely.
 */
export function OfflineState({ message }: { message: string }) {
  // Shown at once, even over a page loader mid-cycle (owner ruling 2026-11-24).
  useInterruptPageLoader();
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
 * The slot for data that hasn't arrived yet (`isPending`): a loader (the page
 * loader unless `placement="inline"`), or the offline message when
 * the read is paused (offline, nothing cached), so the screen settles instead
 * of loading forever. The offline boxes are always in the flow, where the
 * data will appear.
 *
 * For a list with tappable rows below it, pass `rowsBelowShown` (latched):
 * before those rows appear the slot is a loader or the offline message (so
 * the rows can appear below it, not wait forever); once they are on screen the
 * slot keeps the offline box (now "back online") until the list arrives, so it
 * changes height once, after a reconnect. Without rows below (the slot is the
 * last thing on screen) a plain swap is safe.
 */
export function PendingSlot({
  paused,
  rowsBelowShown = false,
  label,
  offlineMessage,
  ...where
}: {
  paused: boolean;
  rowsBelowShown?: boolean;
  /** The loader's screen-reader label. */
  label?: string;
  offlineMessage: string;
} & LoaderPlacement) {
  if (paused) return <OfflineState message={offlineMessage} />;
  if (rowsBelowShown) return <OfflineState message="Back online. Loading…" />;
  return (
    <LoadingState {...where} {...(label !== undefined ? { label } : {})} />
  );
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
  // Shown at once, even over a page loader mid-cycle (owner ruling 2026-11-24).
  useInterruptPageLoader();
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
