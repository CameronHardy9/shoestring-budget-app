// The application clock. Every time rule in the DAL (today, expiries, windows,
// created_at) reads this, never the database clock, so tests can freeze time
// (docs/contracts/test-hooks.md). The one exception is purge_security_events(),
// which uses the database clock on purpose (F-26).
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

/** A clock that tests (and the seed) can set and advance. */
export interface ManualClock {
  readonly clock: Clock;
  set(instant: Date | string): void;
  advance(ms: number): void;
}

export function manualClock(start: Date | string): ManualClock {
  let now = new Date(start);
  return {
    clock: () => new Date(now.getTime()),
    set(instant) {
      now = new Date(instant);
    },
    advance(ms) {
      now = new Date(now.getTime() + ms);
    },
  };
}
