// UUID v4 from crypto.getRandomValues. crypto.randomUUID only exists in secure
// contexts, and phone testing over the LAN (make dev LAN=1) is plain http, so
// it cannot be used for request IDs or idempotency keys.

export function uuidV4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 9562 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Idempotency-Key for one user intent (ADR-0002): create it when the form opens,
 * reuse it on every retry of that save, and make a new one after a success.
 */
export function newIdempotencyKey(): string {
  return uuidV4();
}
