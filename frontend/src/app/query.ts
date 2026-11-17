// TanStack Query, in memory only (ADR-0002: no persistence, cleared at sign-out).
import { QueryClient } from "@tanstack/react-query";
import {
  ApiError,
  NetworkError,
  UnexpectedResponseError,
} from "../api/errors.ts";

/** Reads retry only for failures that may be temporary; never for 4xx. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (error instanceof NetworkError || error instanceof UnexpectedResponseError)
    return true;
  return (
    error instanceof ApiError &&
    (error.code === "UNAVAILABLE" || error.code === "INTERNAL")
  );
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        staleTime: 30_000,
        refetchOnWindowFocus: true,
      },
      // Writes are retried by the person (same Idempotency-Key), never silently.
      // "Online to save" (ADR-0002, owner ruling round 7): a write is always
      // sent, so offline it fails at once with NetworkError and the form keeps
      // the entry. The default ("online") would pause it behind a spinner
      // until the connection returned, then send it unseen.
      mutations: { retry: false, networkMode: "always" },
    },
  });
}

export const queryClient = createQueryClient();
