import { Link } from "react-aria-components";
import { AuthLayout } from "./auth/AuthLayout.tsx";

/** Unknown path, or a budget the API answers 404 for (missing or no access). */
export function NotFoundScreen({
  budgetMissing = false,
}: {
  budgetMissing?: boolean;
}) {
  return (
    <AuthLayout
      title={budgetMissing ? "Budget not found" : "Page not found"}
      intro={
        budgetMissing
          ? "This budget doesn't exist, was deleted, or you don't have access to it."
          : "There's nothing at this address."
      }
    >
      <Link
        href="/"
        className="flex min-h-touch items-center font-semibold text-brand"
      >
        Go to your budget
      </Link>
    </AuthLayout>
  );
}
