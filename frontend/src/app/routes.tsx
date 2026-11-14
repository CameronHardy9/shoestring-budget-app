// Every route the SPA serves, including the email-link routes in auth.md §15
// (stable paths). Access: "public" (anyone), "guest" (signed-out pages that
// send a signed-in person on), "auth" (sign-in required; the requested path is
// remembered in memory and restored after sign-in).
import { lazy, type ReactNode } from "react";
import { BudgetLayout } from "../screens/budget/BudgetLayout.tsx";
import { NotFoundScreen } from "../screens/NotFoundScreen.tsx";
import { matchPath, Redirect } from "./router.tsx";

const SignInScreen = lazy(() => import("../screens/auth/SignInScreen.tsx"));
const SignupScreen = lazy(() => import("../screens/auth/SignupScreen.tsx"));
const ResetPasswordScreen = lazy(
  () => import("../screens/auth/ResetPasswordScreen.tsx"),
);
const ConfirmEmailScreen = lazy(() =>
  import("../screens/auth/EmailLinkScreens.tsx").then((m) => ({
    default: m.ConfirmEmailScreen,
  })),
);
const CancelEmailChangeScreen = lazy(() =>
  import("../screens/auth/EmailLinkScreens.tsx").then((m) => ({
    default: m.CancelEmailChangeScreen,
  })),
);
const HomeScreen = lazy(() => import("../screens/HomeScreen.tsx"));
const CreateBudgetScreen = lazy(
  () => import("../screens/CreateBudgetScreen.tsx"),
);
const OverviewScreen = lazy(
  () => import("../screens/budget/OverviewScreen.tsx"),
);
const TransactionsScreen = lazy(
  () => import("../screens/budget/TransactionsScreen.tsx"),
);
const MoreScreen = lazy(() => import("../screens/MoreScreen.tsx"));
const SecurityScreen = lazy(
  () => import("../screens/settings/SecurityScreen.tsx"),
);
const AccountScreen = lazy(
  () => import("../screens/settings/AccountScreen.tsx"),
);
const SessionsScreen = lazy(
  () => import("../screens/settings/SessionsScreen.tsx"),
);
const DeletedBudgetsScreen = lazy(
  () => import("../screens/settings/DeletedBudgetsScreen.tsx"),
);
const InvitationsScreen = lazy(
  () => import("../screens/InvitationsScreen.tsx"),
);
const CategoriesScreen = lazy(
  () => import("../screens/budget/CategoriesScreen.tsx"),
);
const MembersScreen = lazy(() => import("../screens/budget/MembersScreen.tsx"));

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
