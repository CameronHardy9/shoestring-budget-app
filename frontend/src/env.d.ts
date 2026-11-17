// Build-time variables (Vite inlines them; .env.example documents each).
interface ImportMetaEnv {
  /** Sentry DSN of the web project. Unset: no error tracking, nothing sent. */
  readonly VITE_SENTRY_DSN?: string;
  /** Release tag (git SHA) for Sentry events; same value as APP_RELEASE. */
  readonly VITE_APP_RELEASE?: string;
}
