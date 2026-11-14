// React Aria injects two constant <style> elements at runtime: usePress (every
// pressable, all platforms) and usePreventScroll (open modals on iOS WebKit).
// Under the production CSP (`style-src 'self'`) both are blocked. Allowing their
// exact SHA-256 hashes permits only these two fixed rule sets, which is narrower
// than the `'unsafe-inline'` exception FINDINGS.md would otherwise need.
//
// scripts/csp-style-hashes.test.ts recomputes these from the installed
// react-aria, so a dependency update that changes them fails make check.
// The backend's CSP header must carry the same values (cross-area request).
export const REACT_ARIA_STYLE_HASHES = [
  "sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o=",
  "sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg=",
] as const;

/** The style-src directive value the production CSP needs. */
export const STYLE_SRC = [
  "'self'",
  ...REACT_ARIA_STYLE_HASHES.map((h) => `'${h}'`),
].join(" ");
