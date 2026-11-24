// Every route the SPA serves, including the email-link routes in auth.md §15
// (stable paths). Access: "public" (anyone), "guest" (signed-out pages that
// send a signed-in person on), "auth" (sign-in required; the requested path is
// remembered in memory and restored after sign-in).
import type { ReactNode } from "react";
import { BudgetLayout } from "../screens/budget/BudgetLayout.tsx";
import { NotFoundScreen } from "../screens/NotFoundScreen.tsx";
import { lazyScreen } from "./lazy-screen.tsx";
import { matchPath, Redirect } from "./router.tsx";

const SignInScreen = lazyScreen(
  async () => (await import("../screens/auth/SignInScreen.tsx")).default,
);
const SignupScreen = lazyScreen(
  async () => (await import("../screens/auth/SignupScreen.tsx")).default,
);
const ResetPasswordScreen = lazyScreen(
  async () => (await import("../screens/auth/ResetPasswordScreen.tsx")).default,
);
const ConfirmEmailScreen = lazyScreen(
  async () =>
    (await import("../screens/auth/EmailLinkScreens.tsx")).ConfirmEmailScreen,
);
const CancelEmailChangeScreen = lazyScreen(
  async () =>
    (await import("../screens/auth/EmailLinkScreens.tsx"))
      .CancelEmailChangeScreen,
);
const HomeScreen = lazyScreen(
  async () => (await import("../screens/HomeScreen.tsx")).default,
);
const CreateBudgetScreen = lazyScreen(
  async () => (await import("../screens/CreateBudgetScreen.tsx")).default,
);
const OverviewScreen = lazyScreen(
  async () => (await import("../screens/budget/OverviewScreen.tsx")).default,
);
const TransactionsScreen = lazyScreen(
  async () =>
    (await import("../screens/budget/TransactionsScreen.tsx")).default,
);
const MoreScreen = lazyScreen(
  async () => (await import("../screens/MoreScreen.tsx")).default,
);
const SecurityScreen = lazyScreen(
  async () => (await import("../screens/settings/SecurityScreen.tsx")).default,
);
const AccountScreen = lazyScreen(
  async () => (await import("../screens/settings/AccountScreen.tsx")).default,
);
const SessionsScreen = lazyScreen(
  async () => (await import("../screens/settings/SessionsScreen.tsx")).default,
);
const DeletedBudgetsScreen = lazyScreen(
  async () =>
    (await import("../screens/settings/DeletedBudgetsScreen.tsx")).default,
);
const InvitationsScreen = lazyScreen(
  async () => (await import("../screens/InvitationsScreen.tsx")).default,
);
const CategoriesScreen = lazyScreen(
  async () => (await import("../screens/budget/CategoriesScreen.tsx")).default,
);
const MembersScreen = lazyScreen(
  async () => (await import("../screens/budget/MembersScreen.tsx")).default,
);

/**
 * The tab bar's screens, preloaded once the first page is revealed
 * (app/preload.ts), so a first tab visit renders without suspending.
 */
export const TAB_SCREENS = [
  OverviewScreen,
  TransactionsScreen,
  CategoriesScreen,
  MoreScreen,
] as const;

export type Access = "public" | "guest" | "auth";

export interface RouteDef {
  pattern: string;
  access: Access;
  title: string;
  render: (params: Record<string, string>) => ReactNode;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function budgetRoute(
  params: Record<string, string>,
  render: (budgetId: string) => ReactNode,
): ReactNode {
  const budgetId = params.budgetId ?? "";
  return UUID.test(budgetId) ? (
    render(budgetId)
  ) : (
    <NotFoundScreen budgetMissing />
  );
}

export const ROUTES: readonly RouteDef[] = [
  {
    pattern: "/signin",
    access: "guest",
    title: "Sign in",
    render: () => <SignInScreen />,
  },
  {
    pattern: "/signup",
    access: "public",
    title: "Create your account",
    render: () => <SignupScreen />,
  },
  {
    pattern: "/reset-password",
    access: "public",
    title: "Reset password",
    render: () => <ResetPasswordScreen />,
  },
  {
    pattern: "/cancel-email-change",
    access: "public",
    title: "Undo email change",
    render: () => <CancelEmailChangeScreen />,
  },
  {
    pattern: "/confirm-email",
    access: "auth",
    title: "Confirm email",
    render: () => <ConfirmEmailScreen />,
  },
  {
    pattern: "/",
    access: "auth",
    title: "Shoestring",
    render: () => <HomeScreen />,
  },
  {
    pattern: "/budgets/new",
    access: "auth",
    title: "New budget",
    render: () => <CreateBudgetScreen />,
  },
  {
    pattern: "/budgets/:budgetId",
    access: "auth",
    title: "Overview",
    render: (p) =>
      budgetRoute(p, (id) => (
        <BudgetLayout key={id} budgetId={id} active="overview">
          <OverviewScreen />
        </BudgetLayout>
      )),
  },
  {
    pattern: "/budgets/:budgetId/transactions",
    access: "auth",
    title: "Transactions",
    render: (p) =>
      budgetRoute(p, (id) => (
        <BudgetLayout key={id} budgetId={id} active="transactions">
          <TransactionsScreen />
        </BudgetLayout>
      )),
  },
  {
    pattern: "/budgets/:budgetId/categories",
    access: "auth",
    title: "Categories and limits",
    render: (p) =>
      budgetRoute(p, (id) => (
        <BudgetLayout key={id} budgetId={id} active="budgets">
          <CategoriesScreen />
        </BudgetLayout>
      )),
  },
  {
    pattern: "/budgets/:budgetId/members",
    access: "auth",
    title: "Members and settings",
    render: (p) =>
      budgetRoute(p, (id) => (
        <BudgetLayout key={id} budgetId={id} active="budgets">
          <MembersScreen />
        </BudgetLayout>
      )),
  },
  {
    pattern: "/more",
    access: "auth",
    title: "More",
    render: () => <MoreScreen />,
  },
  {
    pattern: "/settings/security",
    access: "auth",
    title: "Security",
    render: () => <SecurityScreen />,
  },
  {
    pattern: "/settings/account",
    access: "auth",
    title: "Account",
    render: () => <AccountScreen />,
  },
  {
    pattern: "/settings",
    access: "auth",
    title: "Settings",
    render: () => <Redirect to="/more" />,
  },
  {
    pattern: "/settings/sessions",
    access: "auth",
    title: "Signed-in devices",
    render: () => <SessionsScreen />,
  },
  {
    pattern: "/settings/deleted-budgets",
    access: "auth",
    title: "Deleted budgets",
    render: () => <DeletedBudgetsScreen />,
  },
  {
    pattern: "/invitations",
    access: "auth",
    title: "Invitations",
    render: () => <InvitationsScreen />,
  },
];

export function findRoute(
  pathname: string,
): { route: RouteDef; params: Record<string, string> } | null {
  for (const route of ROUTES) {
    const params = matchPath(route.pattern, pathname);
    if (params) return { route, params };
  }
  return null;
}
