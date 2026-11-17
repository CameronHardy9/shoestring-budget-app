// Helpers for "nothing moves under a finger" tests. jsdom has no layout, so
// the property tested is structural: while something is loading, no tappable
// control follows the loading region (only content after it could be pushed
// down when it is replaced), and replies can be held back to test that window.

/** A promise resolved by the test, for holding back a mocked reply. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const TAPPABLE =
  'a[href], button, input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';

/** Controls inside `root` that come after `el` in document order. */
export function tappableAfter(el: Element, root: Element): Element[] {
  return [...root.querySelectorAll(TAPPABLE)].filter(
    (node) =>
      !el.contains(node) &&
      (el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !==
        0,
  );
}
