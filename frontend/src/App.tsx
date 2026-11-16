// App root: providers, then the auth guard in front of every route.
import { QueryClientProvider } from "@tanstack/react-query";
import { Suspense, useEffect, useState } from "react";
import { useAuth, AuthProvider } from "./app/auth.tsx";
import { queryClient } from "./app/query.ts";
import { ReauthProvider } from "./app/reauth.tsx";
import { lazyScreen } from "./app/lazy-screen.tsx";
import { AppRouter, navigate, Redirect, useLocation } from "./app/router.tsx";
import { findRoute } from "./app/routes.tsx";
import { applyUpdate, useUpdateAvailable } from "./app/sw-register.ts";
import { ToastProvider } from "./app/toast.tsx";
import { Button } from "./components/Button.tsx";
import { ErrorState, LoadingState } from "./components/States.tsx";
import { rememberReturnPath, takeReturnPath } from "./lib/return-path.ts";
import { NotFoundScreen } from "./screens/NotFoundScreen.tsx";

const PendingDeletionScreen = lazyScreen(
  async () =>
    (await import("./screens/auth/PendingDeletionScreen.tsx")).default,
);

function FullPage({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-md px-6 pt-16">{children}</main>;
}

function SendToSignIn({ href }: { href: string }) {
  useEffect(() => {
    rememberReturnPath(href);
    navigate("/signin", { replace: true });
  }, [href]);
  return null;
}

function AfterSignIn() {
  const [to] = useState(() => takeReturnPath() ?? "/");
  return <Redirect to={to} />;
}

function Routes() {
  const location = useLocation();
  const { status, refresh } = useAuth();
  const found = findRoute(location.pathname);

  useEffect(() => {
    document.title =
      found && found.route.title !== "Shoestring"
        ? `${found.route.title} · Shoestring`
        : "Shoestring";
  }, [found]);

  if (status.kind === "loading") {
    return (
      <FullPage>
        <h1 className="sr-only">Shoestring</h1>
        <LoadingState rows={2} label="Starting Shoestring…" />
      </FullPage>
    );
  }
  if (status.kind === "error") {
    return (
      <FullPage>
        <h1 className="mb-4 text-2xl font-semibold text-fg">Shoestring</h1>
        <ErrorState
          error={status.error}
          title="Couldn't reach Shoestring"
          offlineMessage="You're offline. Shoestring needs a connection to show your budget and save changes."
          onRetry={() => void refresh()}
        />
      </FullPage>
    );
  }
  if (!found) return <NotFoundScreen />;
  const { route, params } = found;
  if (route.access === "auth") {
    if (status.kind !== "signedIn")
      return <SendToSignIn href={location.href} />;
    if (status.me.deletion) {
      return (
        <Suspense fallback={null}>
          <PendingDeletionScreen />
        </Suspense>
      );
    }
  }
  if (route.access === "guest" && status.kind === "signedIn")
    return <AfterSignIn />;
  return (
    <Suspense
      fallback={
        <FullPage>
          <LoadingState rows={2} />
        </FullPage>
      }
    >
      {route.render(params)}
    </Suspense>
  );
}

function UpdateBanner() {
  const available = useUpdateAvailable();
  if (!available) return null;
  return (
    <div
      role="status"
      className="pt-safe fixed inset-x-0 top-0 z-50 flex justify-center px-4"
      data-testid="update-banner"
    >
      <div className="flex items-center gap-3 rounded-full bg-fg py-1.5 pr-1.5 pl-4 text-sm text-canvas shadow-2">
        A new version of Shoestring is ready.
        <Button size="sm" shape="pill" onPress={applyUpdate}>
          Reload
        </Button>
      </div>
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <ReauthProvider>
            <AppRouter>
              <Routes />
              <UpdateBanner />
            </AppRouter>
          </ReauthProvider>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
