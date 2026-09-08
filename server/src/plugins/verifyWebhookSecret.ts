/**
 * Shared constant-time header-secret check for inbound webhooks that don't
 * sign their payload (Asaas, Channex — neither uses HMAC). Extracted from
 * `webhooks.ts`'s original Asaas-only inline check per
 * SPEC-modulo-12B-reservas-entrantes.md § 3.3, so the Channex webhook
 * doesn't duplicate — or drift from — the same comparison logic.
 *
 * `timingSafeEqual` requires equal-length buffers, so a length mismatch is
 * checked first (that comparison itself doesn't need to be constant-time —
 * only the actual byte-by-byte comparison of two equal-length secrets does).
 */
import { timingSafeEqual } from 'node:crypto';

export function isValidWebhookSecret(receivedToken: unknown, expectedToken: string): boolean {
  if (typeof receivedToken !== 'string') return false;

  const expected = Buffer.from(expectedToken);
  const received = Buffer.from(receivedToken);

  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
