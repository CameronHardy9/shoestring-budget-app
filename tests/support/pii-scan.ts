// Amount scan for the Sentry no-PII gate (e2e/csp-prod/sentry-no-pii.spec.ts),
// kept pure so `make check` can prove it (pii-scan.test.ts).
//
// The planted amount ($87.65, 8765 cents) must not appear anywhere in an
// envelope. Some tokens the envelope legitimately carries are ID- or
// position-shaped and can contain those digits by chance; they are masked
// first, and only they:
//   - UUIDs (8-4-4-4-12 hex) in API paths, user.id and the requestId tag.
//     UUIDv7's leading groups come from the clock, so "-8765-" shows up at
//     certain times (a real false alarm on csp-prod-chromium, 2026-11-17);
//   - 32-hex IDs (event_id, trace IDs);
//   - the numeric values of the keys the number walk skips as well:
//     lineno, colno (a minified bundle's columns run into the thousands),
//     timestamp, status_code.
// Everything else, a non-UUID path segment included, is still scanned.

/** The planted amount in every form a leak could take. */
export const AMOUNT_PATTERNS: readonly RegExp[] = [
  /\$\s?87\.65/,
  /(?<![\d.])87\.65(?!\d)/,
  /(?<![\w.])8765(?![\w.])/,
];

const UUID_TOKEN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX32_TOKEN = /\b[0-9a-f]{32}\b/gi;
const POSITION_VALUE =
  /"(lineno|colno|timestamp|status_code)":\s*-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** Replaces the allowlisted ID- and position-shaped tokens with fixed text. */
export function maskAllowedIds(text: string): string {
  return text
    .replace(UUID_TOKEN, "<uuid>")
    .replace(HEX32_TOKEN, "<hex32>")
    .replace(POSITION_VALUE, '"$1":0');
}

/** The first amount pattern that matches outside the masked tokens, or null. */
export function findAmount(text: string): RegExp | null {
  const masked = maskAllowedIds(text);
  return AMOUNT_PATTERNS.find((re) => re.test(masked)) ?? null;
}
