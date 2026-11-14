// The application clock (ADR-0005, test-hooks.md). Every time rule reads it:
// "today", expiries, sliding/absolute sessions, rate-limit windows and the
// email budget day. The DAL receives the same clock. Only the dev-entry test
// hooks can freeze it; production code never calls freeze().

export interface AppClock {
  now(): Date;
  /** Freeze at an instant, or return to real time with null. */
  freeze(instant: Date | null): void;
  readonly frozen: boolean;
}

export function createAppClock(real: () => number = Date.now): AppClock {
  let frozenAt: number | null = null;
  return {
    now: () => new Date(frozenAt ?? real()),
    freeze(instant) {
      frozenAt = instant === null ? null : instant.getTime();
    },
    get frozen() {
      return frozenAt !== null;
    },
  };
}
