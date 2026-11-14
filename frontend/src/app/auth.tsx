// Session state for the whole app (auth.md §2-§5, ARCHITECTURE "No financial
// data on the device").
// - Boot: GET /auth/session decides signed in, MFA pending or signed out.
// - Every AuthState response replaces the in-memory CSRF token.
// - 401 UNAUTHENTICATED anywhere: clear cached data, remember where the person
//   was (memory only) and show sign-in. Unsaved input lives in memory stores
//   (see quick-add drafts) and survives the re-login in this tab.
// - bfcache restore: clear everything and re-check the session before
//   rendering (F-32).
// - Sign-out: POST /auth/logout, clear memory, full location.replace('/signin').
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, onUnauthenticated, unwrap } from "../api/client.ts";
import { ApiError, isClientError, type ClientError } from "../api/errors.ts";
import { clearSessionMemory, setCsrfToken } from "../api/session.ts";
import type { AuthState, Me, Schemas } from "../api/types.ts";
import { rememberReturnPath } from "../lib/return-path.ts";
import { queryClient } from "./query.ts";

export type AuthStatus =
  | { kind: "loading" }
  | { kind: "error"; error: ClientError }
  | { kind: "signedOut" }
  | { kind: "mfa"; methods: Schemas["MfaMethod"][]; expiresAt: string }
  | { kind: "signedIn"; me: Me; session: Schemas["CurrentSession"] };

export interface Auth {
  status: AuthStatus;
  /** Apply an AuthState from login, sign-up, MFA verify or GET /auth/session. */
  applyAuthState: (state: AuthState) => void;
  /** Re-read the session (e.g. after MFA changes). */
  refresh: () => Promise<void>;
  /** Replace the signed-in user (e.g. after cancelling deletion). */
  setMe: (me: Me) => void;
  /** Forget the session locally (after the server revoked it). */
  forget: () => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<Auth | null>(null);

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("useAuth outside AuthProvider");
  return auth;
}

/** The signed-in user; only for screens behind the auth guard. */
export function useMe(): Me {
  const { status } = useAuth();
  if (status.kind !== "signedIn")
    throw new Error("useMe needs a signed-in user");
  return status.me;
}

function clearAll(): void {
  queryClient.clear();
  clearSessionMemory();
}

export function AuthProvider({
  children,
  initial,
}: {
  children: ReactNode;
  /** Tests only: skip the boot request. */
  initial?: AuthStatus;
}) {
  const [status, setStatus] = useState<AuthStatus>(
    initial ?? { kind: "loading" },
  );
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const applyAuthState = useCallback((state: AuthState) => {
    setCsrfToken(state.csrfToken);
    setStatus(
      state.state === "authenticated"
        ? { kind: "signedIn", me: state.user, session: state.session }
        : {
            kind: "mfa",
            methods: state.mfaMethods,
            expiresAt: state.expiresAt,
          },
    );
  }, []);

  /** GET /auth/session → the status it implies (applies the CSRF token). */
  const readSession = useCallback(async (): Promise<AuthStatus> => {
    try {
      const state = await unwrap(api.GET("/auth/session"));
      setCsrfToken(state.csrfToken);
      return state.state === "authenticated"
        ? { kind: "signedIn", me: state.user, session: state.session }
        : {
            kind: "mfa",
            methods: state.mfaMethods,
            expiresAt: state.expiresAt,
          };
    } catch (error) {
      if (error instanceof ApiError && error.code === "UNAUTHENTICATED") {
        clearSessionMemory();
        return { kind: "signedOut" };
      }
      if (isClientError(error)) return { kind: "error", error };
      throw error;
    }
  }, []);

  const refresh = useCallback(async () => {
    setStatus(await readSession());
  }, [readSession]);

  const forget = useCallback(() => {
    clearAll();
    setStatus({ kind: "signedOut" });
  }, []);

  const signOut = useCallback(async () => {
    try {
      await unwrap(api.POST("/auth/logout"));
    } catch {
      // Signed out locally either way; the cookie expires on its own.
    }
    clearAll();
    window.location.replace("/signin");
  }, []);

  const setMe = useCallback((me: Me) => {
    setStatus((s) => (s.kind === "signedIn" ? { ...s, me } : s));
  }, []);

  useEffect(() => {
    if (initial) return;
    let active = true;
    void readSession().then((next) => {
      if (active) setStatus(next);
    });
    return () => {
      active = false;
    };
  }, [initial, readSession]);

  // Any 401 UNAUTHENTICATED while signed in: back to sign-in, then return.
  useEffect(
    () =>
      onUnauthenticated(() => {
        const current = statusRef.current.kind;
        if (current !== "signedIn" && current !== "mfa") return;
        rememberReturnPath(window.location.pathname + window.location.search);
        clearAll();
        setStatus({ kind: "signedOut" });
      }),
    [],
  );

  // Back/forward cache: never show restored data before re-checking (F-32).
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      clearAll();
      setStatus({ kind: "loading" });
      void refresh();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [refresh]);

  const value = useMemo(
    () => ({ status, applyAuthState, refresh, setMe, forget, signOut }),
    [status, applyAuthState, refresh, setMe, forget, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
