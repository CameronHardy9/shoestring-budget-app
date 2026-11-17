// Renders UI inside the app's providers with a fresh in-memory query cache.
import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { setCsrfToken } from "../api/session.ts";
import { AuthProvider, type AuthStatus } from "../app/auth.tsx";
import { createQueryClient } from "../app/query.ts";
import { ReauthProvider } from "../app/reauth.tsx";
import { AppRouter } from "../app/router.tsx";
import { ToastProvider } from "../app/toast.tsx";
import { CSRF, me, session } from "./fixtures.ts";

export const signedIn: AuthStatus = { kind: "signedIn", me, session };

export function renderWithApp(
  ui: ReactElement,
  { auth = signedIn, path = "/" }: { auth?: AuthStatus; path?: string } = {},
) {
  window.history.replaceState(null, "", path);
  setCsrfToken(CSRF);
  const client = createQueryClient();
  // Merged, so tests keep the app's other defaults (mutation networkMode).
  const defaults = client.getDefaultOptions();
  client.setDefaultOptions({
    queries: { ...defaults.queries, retry: false, staleTime: Infinity },
    mutations: { ...defaults.mutations, retry: false },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <AuthProvider initial={auth}>
          <ToastProvider>
            <ReauthProvider>
              <AppRouter>{ui}</AppRouter>
            </ReauthProvider>
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>,
    ),
  };
}
