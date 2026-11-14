import type { ReactNode } from "react";

/** A titled card on settings-style pages. */
export function Section({
  title,
  children,
  id,
  action,
}: {
  title: string;
  children: ReactNode;
  id: string;
  action?: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-lg bg-surface p-4 shadow-1"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={id} className="text-lg font-semibold text-fg">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Page wrapper for non-budget screens inside the shell. */
export function PageColumn({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 px-4 pt-6 lg:px-8 lg:pt-8">
      <div>
        <h1 className="text-2xl font-semibold text-fg">{title}</h1>
        {intro ? (
          <div className="mt-1 text-sm text-fg-muted">{intro}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
