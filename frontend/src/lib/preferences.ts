// The only device storage the app uses (ADR-0002): the theme preference and the
// last-used budget ID. Nothing financial, no tokens. Storage can be unavailable
// (private mode, quota, disabled), so every access is best effort.

export type ThemePreference = "system" | "light" | "dark";

const THEME_KEY = "shoestring.theme";
const LAST_BUDGET_KEY = "shoestring.lastBudgetId";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    const s = storage();
    if (value === null) s?.removeItem(key);
    else s?.setItem(key, value);
  } catch {
    // Best effort: a preference that cannot be saved is not an error.
  }
}

export function getThemePreference(): ThemePreference {
  const value = read(THEME_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

/** Applies a theme to <html>: "system" follows prefers-color-scheme. */
export function applyTheme(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement,
): void {
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);
  // The browser UI colour follows a manual choice; "system" keeps the media
  // queries in index.html.
  for (const meta of document.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"]',
  )) {
    meta.dataset.media ??= meta.media;
    meta.dataset.content ??= meta.content;
    if (preference === "system") {
      meta.media = meta.dataset.media;
      meta.content = meta.dataset.content;
    } else {
      meta.media = "all";
      meta.content = preference === "dark" ? "#0e1014" : "#f4f5f7";
    }
  }
}

export function setThemePreference(preference: ThemePreference): void {
  write(THEME_KEY, preference === "system" ? null : preference);
  applyTheme(preference);
}

export function getLastBudgetId(): string | null {
  const value = read(LAST_BUDGET_KEY);
  return value !== null && UUID.test(value) ? value : null;
}

export function setLastBudgetId(budgetId: string | null): void {
  write(
    LAST_BUDGET_KEY,
    budgetId !== null && UUID.test(budgetId) ? budgetId : null,
  );
}
