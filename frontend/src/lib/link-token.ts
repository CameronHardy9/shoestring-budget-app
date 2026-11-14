// Fragment hygiene (auth.md §4, F-06). Emailed links carry one-time tokens in
// the URL fragment (/signup#token=…). This runs in the app's first module,
// before error tracking starts and before any route renders: it moves the
// token into memory and removes the fragment from the address bar and history.

/** Contract `Token`: base64url, 43–64 characters. */
const TOKEN = /^[A-Za-z0-9_-]{43,64}$/;

export interface LinkToken {
  /** The path the token arrived on, e.g. "/reset-password". */
  path: string;
  token: string;
}

let captured: LinkToken | null = null;

/**
 * Reads `#token=…` from the location into memory and strips any fragment with
 * history.replaceState. Returns what was captured (also kept for takeLinkToken).
 */
export function captureLinkToken(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState" | "state">,
): LinkToken | null {
  if (location.hash === "") return null;
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("token");
  history.replaceState(history.state, "", location.pathname + location.search);
  captured =
    token !== null && TOKEN.test(token)
      ? { path: location.pathname, token }
      : null;
  return captured;
}

/** Hands the token to the screen for `path` once; null if none or another path's. */
export function takeLinkToken(path: string): string | null {
  if (!captured || captured.path !== path) return null;
  const { token } = captured;
  captured = null;
  return token;
}

/**
 * Reads the token for `path` without consuming it, so it survives a detour
 * through sign-in (/confirm-email) and React re-renders. Call clearLinkToken
 * once the token has been used.
 */
export function peekLinkToken(path: string): string | null {
  return captured && captured.path === path ? captured.token : null;
}

export function clearLinkToken(): void {
  captured = null;
}
