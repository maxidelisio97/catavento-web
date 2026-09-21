/**
 * sdd/asaas-pagarme-migration design (obs #257), decision A9/A14 — POST
 * /webhooks/pagarme. Raw-body capture + HMAC signature preHandler + REAL
 * event routing (task A14, PR 4 of 6 — replaces PR 3's log-only skeleton).
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ Non-negotiable (server/CLAUDE.md, spec's "Webhook signature           │
 * │ verification" requirement): a request with a missing/invalid          │
 * │ signature is rejected BEFORE any DB read or write, full stop. That    │
 * │ check happens first in the handler below, before `request.body` is    │
 * │ even looked at. `order.paid` is the ONLY event type allowed to move a │
 * │ reservation to `confirmed` (spec's "Event → status mapping"           │
 * │ requirement) — it is the ONLY branch below that calls                 │
 * │ `processPaymentReceived`. Every other known event only updates        │
 * │ `payments.status`, never `reservations.status`.                       │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * `order.paid` routes through `processPaymentReceived` — the SAME function
 * the Asaas webhook (webhooks.ts) uses, post-signature-verification only —
 * so it gets the exact same rigor: advisory lock, idempotency, overpayment
 * flag, `assertReservationNightsConsistency`, and `isReservationActive`
 * (all inside confirmPendingReservation.ts, untouched by this file).
 * `order.payment_failed`/`checkout.canceled` mark the local row `failed`
 * (never touching `reservations.status`) so the guest can retry — a plain
 * UPDATE, not `processPaymentReceived`, since there is no "money received"
 * state transition on this path. `charge.refunded` is explicitly
 * LOG-ONLY per the design's Open Questions ("refund business logic is out
 * of scope for this migration") — it never confirms and never re-opens an
 * already-cancelled/confirmed reservation.
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
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { config } from '../config.js';
import { isValidPagarmeSignature, PAGARME_SIGNATURE_HEADER } from './verifyPagarmeSignature.js';
import { processPaymentReceived } from '../availability/confirmPendingReservation.js';

/**
 * Per spec (obs #256) and design's event list. `order.paid` is the ONLY
 * event allowed to move a reservation toward confirmation.
 * `order.payment_failed`/`checkout.canceled` mark the local payment row
 * failed without touching reservation state. `charge.refunded` is
 * log-only (design's Open Questions — refund logic out of scope).
 */
const CONFIRMING_EVENT = 'order.paid';
const FAILURE_EVENTS = new Set(['order.payment_failed', 'checkout.canceled']);
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

export interface WebhooksPagarmePluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const webhooksPagarmePlugin: FastifyPluginAsync<WebhooksPagarmePluginOptions> = async (fastify, opts) => {
  const db = opts.db ?? prodDb;

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

    if (!objectId) {
      // Known event but no id anywhere in the envelope this type accepts
      // (design's Open Questions — order-vs-charge id ambiguity is still
      // covered defensively above; this is the case where NONE of the
      // three shapes matched) — nothing to look up, ack and move on rather
      // than 500 or retry-loop Pagar.me forever on an envelope we can't act on.
      fastify.log.warn({ type }, 'pagarme webhook: known event but no object id found in envelope — nothing to do');
      return reply.status(200).send({ received: true });
    }

    if (type === CONFIRMING_EVENT) {
      // THE only path that can confirm a reservation — routed through the
      // exact same function (and thus the exact same rigor: advisory lock,
      // idempotency, overpayment flag, assertReservationNightsConsistency)
      // the Asaas webhook uses. Never a shortcut.
      const outcome = await processPaymentReceived(db, {
        provider: 'pagarme',
        providerPaymentId: objectId,
        rawEvent: request.body,
      });

      if (outcome.kind === 'unknown_payment') {
        fastify.log.warn({ objectId }, 'pagarme webhook: order.paid for unknown local payment');
      } else if (outcome.kind === 'payment_conflict') {
        fastify.log.error(
          { objectId, reservationId: outcome.reservationId },
          'pagarme payment received after the room became unavailable — reservation moved to payment_conflict, refund is manual',
        );
      }

      if (
        (outcome.kind === 'confirmed' || outcome.kind === 'payment_conflict' || outcome.kind === 'payment_marked_received_only') &&
        outcome.overpaymentFlagged
      ) {
        fastify.log.error(
          { objectId, reservationId: outcome.reservationId },
          'pagarme payment received pushed balance_due_cents negative — flagged on the payment row, refund is manual',
        );
      }

      return reply.status(200).send({ received: true });
    }

    if (FAILURE_EVENTS.has(type)) {
      // Marks the local row failed so the guest can retry — never touches
      // reservations.status. Scoped to 'pending' so an already-'received'
      // row (e.g. a late/duplicate failure delivery racing a confirmed
      // order.paid) can never be downgraded by an out-of-order webhook.
      const result = await db
        .updateTable('payments')
        .set({ status: 'failed', updated_at: new Date() })
        .where('provider', '=', 'pagarme')
        .where('provider_payment_id', '=', objectId)
        .where('status', '=', 'pending')
        .executeTakeFirst();

      fastify.log.info(
        { type, objectId, updated: Number(result.numUpdatedRows) },
        'pagarme webhook: payment marked failed',
      );
      return reply.status(200).send({ received: true });
    }

    // charge.refunded: log-only per the design's Open Questions ("refund
    // business logic is out of scope for this migration") — never confirms,
    // never re-opens an already-settled reservation, zero DB writes.
    fastify.log.info(
      { type, objectId },
      'pagarme webhook: charge.refunded received — log-only, no state change (refund logic out of scope)',
    );
    return reply.status(200).send({ received: true });
  });
};

export default webhooksPagarmePlugin;
