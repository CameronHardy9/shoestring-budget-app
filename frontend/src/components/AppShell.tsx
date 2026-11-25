// App frame: bottom tab bar with a central Add button on phones, side rail at
// 1024 px and wider (lg). Navigation is a <nav> landmark with
// aria-current="page" on the active item; the Add button opens quick-add.
import type { ReactNode } from "react";
import { Link } from "react-aria-components";
import { Button } from "./Button.tsx";
import { cx } from "./cx.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { LogoMark } from "./Logo.tsx";
import { PageMain } from "./PageMain.tsx";
import { useOpening } from "./page-loader.ts";

export type NavId = "overview" | "transactions" | "budgets" | "more";

interface NavItem {
  id: NavId;
  label: string;
  icon: IconName;
  href: string;
}

export function navItems(budgetId: string | null): NavItem[] {
  const base = budgetId ? `/budgets/${budgetId}` : null;
  return [
    { id: "overview", label: "Overview", icon: "overview", href: base ?? "/" },
    {
      id: "transactions",
      label: "Transactions",
      icon: "list",
      href: base ? `${base}/transactions` : "/",
    },
    {
      id: "budgets",
      label: "Budgets",
      icon: "budgets",
      href: base ? `${base}/categories` : "/",
    },
    { id: "more", label: "More", icon: "more", href: "/more" },
  ];
}

export interface AppShellProps {
  active: NavId | null;
  budgetId: string | null;
  budgetName?: string | null;
  /** Opens quick-add; hidden when there is no budget to add to. */
  onAdd?: (() => void) | undefined;
  children: ReactNode;
}

function NavLink({
  item,
  active,
  rail,
}: {
  item: NavItem;
  active: boolean;
  rail: boolean;
}) {
  return (
    <Link
      href={item.href}
      {...(active ? { "aria-current": "page" as const } : {})}
      className={cx(
        "flex items-center rounded-md",
        rail
          ? "min-h-touch gap-3 px-3 text-base"
          : "min-h-touch flex-1 flex-col justify-center gap-0.5 text-xs",
        // Active = colour + weight + pill, never colour alone (WCAG 1.4.1).
        active
          ? "font-semibold text-brand-strong"
          : "font-medium text-fg-muted",
        active && rail && "bg-brand-soft",
      )}
    >
      <span
        className={cx(
          "flex items-center justify-center",
          !rail && "rounded-full px-4 py-0.5",
          !rail && active && "bg-brand-soft",
        )}
      >
        <Icon name={item.icon} size={22} />
      </span>
      {item.label}
    </Link>
  );
}

export function AppShell({
  active,
  budgetId,
  budgetName = null,
  onAdd,
  children,
}: AppShellProps) {
  const items = navItems(budgetId);
  // Under the page loader's cover (z-20) the page is inert; the rail and the
  // tab bar stay above it (z-30) and usable, so "+" always works. Except in
  // the opening (cold start, just signed in): then there is no navigation at
  // all, not hidden but absent, until the first page is revealed with it.
  const opening = useOpening();
  return (
    <div className="min-h-dvh bg-canvas lg:flex">
      {opening ? null : (
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-surface px-4 py-2 text-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to content
        </a>
      )}

      {opening ? (
        // The rail's width, so the page is laid out where it will be revealed.
        <div
          aria-hidden="true"
          className="hidden lg:block lg:w-60 lg:shrink-0"
        />
      ) : (
        <aside className="hidden lg:sticky lg:top-0 lg:z-30 lg:flex lg:h-dvh lg:w-60 lg:shrink-0 lg:flex-col lg:gap-6 lg:border-r lg:border-line lg:bg-surface lg:p-4">
          <div className="flex items-center gap-2 px-2 pt-2 text-lg font-bold text-fg">
            <LogoMark size={32} />
            <span className="flex min-w-0 flex-col leading-tight">
              Shoestring
              {budgetName ? (
                <span className="text-sm font-medium text-fg-muted">
                  {budgetName}
                </span>
              ) : null}
            </span>
          </div>
          {onAdd ? (
            <Button
              onPress={onAdd}
              variant="fab"
              className="w-full"
              data-testid="quick-add-open-rail"
            >
              <Icon name="plus" /> Add transaction
            </Button>
          ) : null}
          <nav aria-label="Main" className="flex flex-col gap-1">
            {items.map((item) => (
              <NavLink
                key={item.id}
                item={item}
                active={item.id === active}
                rail
              />
            ))}
          </nav>
        </aside>
      )}

      <PageMain id="main" className="min-w-0 flex-1 pb-28 lg:pb-10">
        {children}
      </PageMain>

      {opening ? null : (
        <nav
          aria-label="Main"
          className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface lg:hidden"
        >
          <div className="mx-auto flex max-w-lg items-center px-2 pt-1">
            {items.slice(0, 2).map((item) => (
              <NavLink
                key={item.id}
                item={item}
                active={item.id === active}
                rail={false}
              />
            ))}
            <div className="flex flex-1 justify-center">
              {onAdd ? (
                <Button
                  onPress={onAdd}
                  aria-label="Add transaction"
                  data-testid="quick-add-open"
                  variant="fab"
                  size="fab"
                  shape="pill"
                  className="-mt-6 shadow-2"
                >
                  <Icon name="plus" size={28} />
                </Button>
              ) : null}
            </div>
            {items.slice(2).map((item) => (
              <NavLink
                key={item.id}
                item={item}
                active={item.id === active}
                rail={false}
              />
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}
