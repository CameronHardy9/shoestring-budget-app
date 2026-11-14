// Per-tab session memory. The CSRF token from AuthState is kept in memory only
// (auth.md §3): never in storage, never in the URL. A new session means a new
// token, so every AuthState response replaces it.

let csrfToken: string | null = null;
let lastRequestId: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

/** Remember the latest request ID (errors.md: "Copy diagnostics"). */
export function setLastRequestId(id: string | null): void {
  lastRequestId = id;
}

export function getLastRequestId(): string | null {
  return lastRequestId;
}

/** Forget everything session-bound (sign-out, 401, bfcache restore). */
export function clearSessionMemory(): void {
  csrfToken = null;
  lastRequestId = null;
}
