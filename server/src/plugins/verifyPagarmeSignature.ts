/**
 * sdd/asaas-pagarme-migration design (obs #257), decision A8 — HMAC
 * signature verification for inbound `/webhooks/pagarme` deliveries.
 *
 * Unlike `verifyWebhookSecret.ts` (Asaas/Channex — a static shared-secret
 * header compare, no signing), Pagar.me's webhook is designed to be
 * HMAC-signed. This module reuses `verifyWebhookSecret.ts`'s
 * constant-time-comparison DISCIPLINE (`timingSafeEqual`, equal-length
 * check first), not its function — signature verification here computes
 * an HMAC digest over the RAW request body first, which
 * `isValidWebhookSecret` doesn't do.
 *
 * GENUINELY UNVERIFIED (no live Pagar.me account yet, no real webhook
 * delivery captured — see design's Open Questions and the tasks
 * artifact's Group B): the exact header name Pagar.me sends the signature
 * in, and the exact HMAC algorithm/encoding it uses. Both are isolated
 * behind the two named constants below so tomorrow's B2 probe is a 2-line
 * change here, not a rewrite of this module or its call site.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** UNVERIFIED — TBD, confirm against a real Pagar.me webhook delivery (task B1/B2). */
export const PAGARME_SIGNATURE_HEADER = 'x-hub-signature';

/** UNVERIFIED — TBD, confirm against a real Pagar.me webhook delivery (task B1/B2). */
export const PAGARME_SIGNATURE_ALGORITHM = 'sha256';

/**
 * Verifies an HMAC signature over the exact raw (un-reparsed) request
 * body. `rawBody` MUST be the literal bytes Pagar.me signed — re-serializing
 * a parsed JSON body can silently produce a different byte sequence (key
 * order, whitespace) and break verification even with the correct secret.
 *
 * Fail-closed on every ambiguous input: missing header, non-string header,
 * empty secret, or a length mismatch (which would make `timingSafeEqual`
 * throw) all return `false` rather than throwing — the caller (the
 * webhook route's preHandler) always gets a clean boolean to gate on.
 */
export function isValidPagarmeSignature(rawBody: string, receivedSignature: unknown, secret: string): boolean {
  if (typeof receivedSignature !== 'string' || receivedSignature.length === 0) return false;
  if (!secret) return false;

  const expectedHex = createHmac(PAGARME_SIGNATURE_ALGORITHM, secret).update(rawBody).digest('hex');

  const expected = Buffer.from(expectedHex, 'hex');
  const received = Buffer.from(receivedSignature, 'hex');

  // Buffer.from(..., 'hex') silently drops trailing invalid hex instead of
  // throwing — an odd-length or non-hex header can produce a buffer whose
  // length still happens to match. That's fine: timingSafeEqual's own
  // byte-for-byte comparison correctly rejects it as long as the LENGTH
  // check below runs first (timingSafeEqual throws on a length mismatch
  // instead of returning false).
  if (expected.length !== received.length) return false;

  return timingSafeEqual(expected, received);
}
