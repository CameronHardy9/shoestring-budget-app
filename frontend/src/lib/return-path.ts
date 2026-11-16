// Return-after-sign-in (auth.md §15): the SPA keeps the requested path in
// memory only, and accepts only an app-relative path, so it is never an open
// redirect. Fragments are dropped (tokens are captured separately, §4).

/** C0 controls and space, DEL and C1 controls. */
function hasControlOrSpace(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Returns a safe app-relative path ("/budgets/1?month=2026-11") or null.
 * Rejects "//host", "/\\host", schemes, backslashes, control characters and
 * anything that does not start with exactly one "/".
 */
export function safeReturnPath(candidate: unknown): string | null {
  if (typeof candidate !== "string" || candidate.length > 2048) return null;
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return null;
  if (candidate.includes("\\") || hasControlOrSpace(candidate)) return null;
  const parsed = new URL(candidate, "https://app.invalid");
  if (parsed.origin !== "https://app.invalid") return null;
  return parsed.pathname + parsed.search;
}

// Bound to the user who was signed in when the path was left (F-54): on a
// shared phone, B signing in after A's session expired must not land on A's
// page. `userId` null means nobody had signed in in this tab yet (a deep link
// opened while signed out), so whoever signs in may use it.
let pending: { path: string; userId: string | null } | null = null;

/** Remember where to go after sign-in (memory only). */
export function rememberReturnPath(path: unknown, userId: string | null): void {
  const safe = safeReturnPath(path);
  pending = safe === null ? null : { path: safe, userId };
}

/** Take (and forget) the remembered path, if it belongs to `userId`. */
export function takeReturnPath(userId: string): string | null {
  const taken = pending;
  pending = null;
  return taken && (taken.userId === null || taken.userId === userId)
    ? taken.path
    : null;
}

/** Forget a path that another user left behind (on sign-in). */
export function forgetReturnPathUnlessFor(userId: string): void {
  if (pending?.userId != null && pending.userId !== userId) pending = null;
}
