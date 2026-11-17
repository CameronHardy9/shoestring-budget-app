import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bufferEarlyErrors,
  reportError,
  resetReporting,
  setReportUser,
  startErrorTracking,
  type Tracker,
  type TrackerOptions,
} from "./report.ts";

afterEach(() => {
  resetReporting();
});

function fakeSdk() {
  const captured: { error: unknown; mechanism: unknown }[] = [];
  let options: TrackerOptions | null = null;
  const load = () =>
    Promise.resolve({
      createTracker: (o: TrackerOptions): Tracker => {
        options = o;
        return {
          capture: (error, mechanism) => captured.push({ error, mechanism }),
        };
      },
    });
  return { captured, load, options: () => options };
}

const base = {
  dsn: "https://k@o1.ingest.us.sentry.io/1",
  release: "r1",
  routeOf: () => "/",
};

describe("error reporting before and after Sentry loads", () => {
  it("buffers uncaught errors until Sentry is up, then sends them once", async () => {
    // A stand-in for window (vitest fails a test on real window "error" events).
    const target = new EventTarget() as unknown as Window;
    const stop = bufferEarlyErrors(target);
    const early = new Error("early");
    target.dispatchEvent(new ErrorEvent("error", { error: early }));
    const sdk = fakeSdk();
    const stopSpy = vi.fn(stop);
    expect(
      await startErrorTracking({
        ...base,
        load: sdk.load,
        stopBuffer: stopSpy,
      }),
    ).toBe(true);
    expect(stopSpy).toHaveBeenCalledOnce();
    expect(sdk.captured).toEqual([
      { error: early, mechanism: { type: "onerror", handled: false } },
    ]);
    // The buffer's listeners are gone: Sentry's own handlers take over.
    target.dispatchEvent(
      new ErrorEvent("error", { error: new Error("later") }),
    );
    expect(sdk.captured).toHaveLength(1);
    reportError(new Error("reported"));
    expect(sdk.captured).toHaveLength(2);
  });

  it("keeps at most 10 errors while waiting", async () => {
    for (let i = 0; i < 25; i++) reportError(new Error(String(i)));
    const sdk = fakeSdk();
    await startErrorTracking({ ...base, load: sdk.load });
    expect(sdk.captured).toHaveLength(10);
  });

  it("passes the current opaque user ID at event time", async () => {
    const sdk = fakeSdk();
    await startErrorTracking({ ...base, load: sdk.load });
    setReportUser("01a1e620-e22d-7090-96c4-741f12e76d63");
    expect(sdk.options()?.userId()).toBe(
      "01a1e620-e22d-7090-96c4-741f12e76d63",
    );
    setReportUser(null);
    expect(sdk.options()?.userId()).toBeNull();
  });

  it("carries on without tracking when the chunk can't load", async () => {
    const stop = vi.fn();
    expect(
      await startErrorTracking({
        ...base,
        load: () =>
          Promise.reject(
            new TypeError("Failed to fetch dynamically imported module"),
          ),
        stopBuffer: stop,
      }),
    ).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(() => {
      reportError(new Error("x"));
    }).not.toThrow();
  });
});
