// /more: switch budget, settings, sign out.
//
// The budget list's length is unknown until it loads (no persisted cache,
// ADR-0002, and long names wrap), so no placeholder can reserve its height. The
// rows below it (settings, theme, Sign out) appear only once the list has
// settled, so nothing tappable is ever on screen and then pushed down.
// Offline with nothing cached the read is paused, never failed: that counts as
// settled too (an offline message instead of the list), so Sign out and its
// "check your connection" path (F-51) stay reachable.
import { useState } from "react";
import { Link } from "react-aria-components";
import { useMe } from "../app/auth.tsx";
import { useBudgets } from "../app/data.ts";
import { AppShell } from "../components/AppShell.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { ErrorState, PendingSlot } from "../components/States.tsx";
import { SegmentedControl } from "../components/SegmentedControl.tsx";
import { SignOutButton } from "../components/SignOutButton.tsx";
import {
  getLastBudgetId,
  getThemePreference,
  setThemePreference,
  type ThemePreference,
} from "../lib/preferences.ts";

function Row({
  href,
  icon,
  label,
  detail,
}: {
  href: string;
  icon: IconName;
  label: string;
  detail?: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex min-h-14 items-center gap-3 px-4 py-2 text-fg"
      >
        <Icon name={icon} size={22} className="text-fg-muted" />
        <span className="flex flex-1 flex-col">
          <span className="font-medium">{label}</span>
          {detail ? (
            <span className="text-sm text-fg-muted">{detail}</span>
          ) : null}
        </span>
        <Icon name="chevronRight" size={18} className="text-fg-muted" />
      </Link>
    </li>
  );
}

export default function MoreScreen() {
  const me = useMe();
  const budgets = useBudgets();
  const last = getLastBudgetId();
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference);
  // Latched: once the rows below are shown they stay, while a paused read
  // resumes after a reconnect.
  const [rowsShown, setRowsShown] = useState(false);
  if (!rowsShown && (!budgets.isPending || budgets.isPaused))
    setRowsShown(true);
  return (
    <AppShell active="more" budgetId={last}>
      <div className="mx-auto flex max-w-2xl flex-col gap-5 px-4 pt-6 lg:px-8 lg:pt-8">
        <div>
          <h1 className="text-2xl font-semibold text-fg">More</h1>
          <p className="text-sm text-fg-muted">
            Signed in as {me.displayName} ({me.email})
          </p>
        </div>
        <section
          aria-labelledby="budgets-heading"
          className="flex flex-col gap-2"
        >
          <h2
            id="budgets-heading"
            className="px-1 text-sm font-semibold text-fg"
          >
            Budgets
          </h2>
          {budgets.isPending ? (
            <PendingSlot
              paused={budgets.isPaused}
              rowsBelowShown={rowsShown}
              rows={2}
              offlineMessage="You're offline. Your budgets will appear when you reconnect."
            />
          ) : budgets.isError ? (
            <ErrorState
              error={budgets.error}
              onRetry={() => void budgets.refetch()}
            />
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-lg bg-surface shadow-1">
              {budgets.data.items.map((b) => (
                <Row
                  key={b.id}
                  href={`/budgets/${b.id}`}
                  icon="budgets"
                  label={b.name}
                  detail={`${b.myRole === "owner" ? "Owner" : "Member"}${b.memberCount > 1 ? ` · ${String(b.memberCount)} people` : ""}${b.id === last ? " · current" : ""}`}
                />
              ))}
              {budgets.data.items.length < 10 ? (
                <Row href="/budgets/new" icon="plus" label="New budget" />
              ) : null}
            </ul>
          )}
        </section>
        {!rowsShown ? null : (
          <>
            <section
              aria-labelledby="settings-heading"
              className="flex flex-col gap-2"
            >
              <h2
                id="settings-heading"
                className="px-1 text-sm font-semibold text-fg"
              >
                Settings
              </h2>
              <ul className="divide-y divide-line overflow-hidden rounded-lg bg-surface shadow-1">
                <Row
                  href="/settings/account"
                  icon="user"
                  label="Account"
                  detail="Name, email, password, export, delete"
                />
                <Row
                  href="/settings/security"
                  icon="shield"
                  label="Security"
                  detail={
                    me.mfa.enabled
                      ? "Two-step verification on"
                      : "Two-step verification off"
                  }
                />
                <Row
                  href="/settings/sessions"
                  icon="user"
                  label="Signed-in devices"
                />
                <Row
                  href="/invitations"
                  icon="user"
                  label="Budget invitations"
                />
                <Row
                  href="/settings/deleted-budgets"
                  icon="trash"
                  label="Deleted budgets"
                />
              </ul>
            </section>
            <section
              aria-labelledby="appearance-heading"
              className="flex flex-col gap-2"
            >
              <h2
                id="appearance-heading"
                className="px-1 text-sm font-semibold text-fg"
              >
                Appearance
              </h2>
              <div className="rounded-lg bg-surface p-4 shadow-1">
                <SegmentedControl
                  label="Theme"
                  value={theme}
                  onChange={(next) => {
                    setTheme(next);
                    setThemePreference(next);
                  }}
                  options={[
                    { id: "system", label: "Automatic" },
                    { id: "light", label: "Light" },
                    { id: "dark", label: "Dark" },
                  ]}
                />
                <p className="mt-2 text-sm text-fg-muted">
                  Automatic follows your phone's setting.
                </p>
              </div>
            </section>
            <SignOutButton />
          </>
        )}
      </div>
    </AppShell>
  );
}
