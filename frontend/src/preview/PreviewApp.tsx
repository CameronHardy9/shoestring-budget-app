// DEV PREVIEW ONLY: renders one proposal screen from the query string, e.g.
// /preview.html?screen=overview&theme=dark&brand=teal&view=table
// Mock data only; makes no API calls.
import { AppShell } from "../components/AppShell.tsx";
import { MockKeypad, KEYPAD_HEIGHT } from "./MockKeypad.tsx";
import { OverviewScreen } from "./OverviewScreen.tsx";
import { QuickAddSheet } from "./QuickAddSheet.tsx";
import { SignInScreen } from "./SignInScreen.tsx";
import { TransactionsScreen } from "./TransactionsScreen.tsx";

export const SCREENS = [
  "signin",
  "signin-error",
  "overview",
  "quick-add",
  "quick-add-split",
  "transactions",
] as const;
export type Screen = (typeof SCREENS)[number];

const noop = () => undefined;

export function PreviewApp({
  screen,
  view,
}: {
  screen: Screen | null;
  view: "chart" | "table";
}) {
  switch (screen) {
    case "signin":
      return <SignInScreen showError={false} />;
    case "signin-error":
      return <SignInScreen showError />;
    case "overview":
      return (
        <AppShell active="overview" budgetId={null} onAdd={noop}>
          <OverviewScreen initialView={view} />
        </AppShell>
      );
    case "quick-add":
      return (
        <>
          <AppShell active="overview" budgetId={null} onAdd={noop}>
            <OverviewScreen />
          </AppShell>
          <QuickAddSheet mode="single" bottomInset={KEYPAD_HEIGHT} />
          <MockKeypad />
        </>
      );
    case "quick-add-split":
      return (
        <>
          <AppShell active="overview" budgetId={null} onAdd={noop}>
            <OverviewScreen />
          </AppShell>
          <QuickAddSheet mode="split" bottomInset={0} />
        </>
      );
    case "transactions":
      return (
        <AppShell active="transactions" budgetId={null} onAdd={noop}>
          <TransactionsScreen />
        </AppShell>
      );
    case null:
      return (
        <main className="mx-auto max-w-md p-6">
          <h1 className="text-2xl font-semibold text-fg">
            Shoestring style preview
          </h1>
          <p className="mt-1 text-fg-muted">
            Dev only. Mock data. Add &amp;theme=dark.
          </p>
          <ul className="mt-4 flex flex-col gap-1">
            {SCREENS.map((s) => (
              <li key={s}>
                <a
                  className="flex min-h-touch items-center font-semibold text-brand"
                  href={`?screen=${s}`}
                >
                  {s}
                </a>
              </li>
            ))}
          </ul>
        </main>
      );
  }
}
