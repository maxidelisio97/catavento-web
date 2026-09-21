/**
 * sdd/asaas-pagarme-migration design (obs #257), decision A9 — POST
 * /webhooks/pagarme. Raw-body capture + HMAC signature preHandler +
 * event-routing SKELETON only (task A9, PR 3 of 6).
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ Non-negotiable (server/CLAUDE.md, task brief): a request with a      │
 * │ missing/invalid signature is rejected BEFORE any DB read or write,   │
 * │ full stop. That check happens first in the handler below, before     │
 * │ `request.body` is even looked at. See webhooksPagarme.test.ts for    │
 * │ the tests proving this (zero payment rows written on 401).           │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Deliberately does NOT call `processPaymentReceived`
 * (`confirmPendingReservation.ts`) yet: that function's
 * `ProcessPaymentReceivedInput` still only accepts `{ asaasPaymentId,
 * rawEvent }` (provider-specific). Generalizing it to `{ provider,
 * providerPaymentId, rawEvent }` and wiring the lookup by `(provider,
 * provider_payment_id)` is task A13 (PR 4) — reaching into that ahead of
 * schedule here would mean either lying about the provider or duplicating
 * A13's rename early, both explicitly out of this PR's scope per the task
 * brief. This route verifies the signature, parses and routes the event,
 * logs what it *would* do, and acks 200 — no DB write of any kind on this
 * path yet.
 *
 * Raw-body capture: Pagar.me signs the exact bytes it sent, so this plugin
 * registers its OWN `application/json` content-type parser (Fastify plugin
 * encapsulation keeps this scoped to this plugin only, same as any other
 * plugin-local override in this codebase) that stores the raw string
 * alongside the parsed body, instead of relying on Fastify's default
 * parser (which only hands back the parsed object, not the original
 * bytes) or re-serializing the parsed body (which can silently produce
 * different bytes than what was signed — see verifyPagarmeSignature.ts's
 * docstring).
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { isValidPagarmeSignature, PAGARME_SIGNATURE_HEADER } from './verifyPagarmeSignature.js';

/**
 * Per spec (obs #256) and design's event list. `order.paid` is the ONLY
 * event allowed to move a reservation toward confirmation, once task
 * A13/A14 wires that up — this route doesn't confirm anything yet, but the
 * distinction is already encoded here so the routing logic doesn't need to
 * change shape when A14 lands, only gain a real DB call.
 */
const CONFIRMING_EVENT = 'order.paid';
const KNOWN_EVENTS = new Set(['order.paid', 'order.payment_failed', 'charge.refunded', 'checkout.canceled']);

interface PagarmeWebhookRequest extends FastifyRequest {
  rawBody?: string;
}

interface PagarmeWebhookBody {
  type?: string;
  /**
   * UNVERIFIED shape (design's Open Questions): whether the envelope
   * identifies the affected object via an order id or a charge id, and
   * whether it's nested under `data.id`, `data.order.id`, or
   * `data.charge.id`. This type accepts all three so the lookup A13 builds
   * can try each rather than assuming one — do not narrow this without a
   * real captured webhook (task B1) to confirm against.
   */
  data?: {
    id?: string;
    order?: { id?: string };
    charge?: { id?: string };
    [key: string]: unknown;
  };
}

const webhooksPagarmePlugin: FastifyPluginAsync = async (fastify) => {
  // Scoped to this plugin's encapsulation context only (Fastify's default
  // plugin behavior) — does not affect the global `application/json`
  // parser used by every other route in `index.ts`.
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (request, rawBody, done) => {
    // `parseAs: 'string'` guarantees a string body at runtime — Fastify's
    // own type declares the callback's second param as `string | Buffer`
    // to cover both `parseAs` modes, so this narrowing is safe.
    const body = rawBody as string;
    (request as PagarmeWebhookRequest).rawBody = body;
    try {
      done(null, body.length ? JSON.parse(body) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  fastify.post<{ Body: PagarmeWebhookBody }>('/webhooks/pagarme', async (request, reply) => {
    const rawBody = (request as PagarmeWebhookRequest).rawBody ?? '';
    const signature = request.headers[PAGARME_SIGNATURE_HEADER];

    // Gate FIRST, before any read of `request.body` — see this file's
    // docstring and server/CLAUDE.md's non-negotiable webhook rule.
    if (!config.pagarme.webhookSecret || !isValidPagarmeSignature(rawBody, signature, config.pagarme.webhookSecret)) {
      return reply.status(401).send({ error: 'invalid_webhook_signature' });
    }

    const { type, data } = request.body ?? {};

    fastify.log.info({ type }, 'pagarme webhook received (signature verified)');

    if (!type || !KNOWN_EVENTS.has(type)) {
      return reply.status(200).send({ received: true });
    }

    const objectId = data?.order?.id ?? data?.charge?.id ?? data?.id;

    fastify.log.info(
      { type, objectId },
      type === CONFIRMING_EVENT
        ? 'pagarme webhook: order.paid received — confirmation wiring pending (task A13/A14, PR 4)'
        : `pagarme webhook: ${type} received — status-only wiring pending (task A13/A14, PR 4)`,
    );

    return reply.status(200).send({ received: true });
  });
};

export default webhooksPagarmePlugin;
