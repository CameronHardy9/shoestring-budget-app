import type { ReactNode } from "react";
import { LogoMark } from "../../components/Logo.tsx";
import { PageMain } from "../../components/PageMain.tsx";

/** Signed-out pages: logo, one column, footer note. */
export function AuthLayout({
  title,
  intro,
  children,
  footer,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <PageMain className="mx-auto flex min-h-dvh max-w-sm flex-col px-6 pt-12 pb-8">
      <div className="flex items-center gap-2.5 text-xl font-bold text-fg">
        <LogoMark />
        Shoestring
      </div>
      <h1 className="mt-10 text-3xl font-semibold text-fg">{title}</h1>
      {intro ? (
        <div className="mt-1 text-base text-fg-muted">{intro}</div>
      ) : null}
      <div className="mt-6 flex flex-col gap-4">{children}</div>
      {footer ? (
        <div className="mt-auto pt-10 text-center text-sm text-fg-muted">
          {footer}
        </div>
      ) : null}
    </PageMain>
  );
}
