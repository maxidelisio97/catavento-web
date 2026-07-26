import type { FastifyPluginAsync } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { config } from '../config.js';
import { processPaymentReceived } from '../availability/confirmPendingReservation.js';

function isValidToken(receivedToken: unknown): boolean {
  if (typeof receivedToken !== 'string') return false;

  const expected = Buffer.from(config.asaas.webhookToken);
  const received = Buffer.from(receivedToken);

  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

interface AsaasWebhookBody {
  event?: string;
  payment?: { id?: string; status?: string };
}

const PAYMENT_RECEIVED_EVENTS = new Set(['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED']);

export interface WebhooksPluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const webhooksPlugin: FastifyPluginAsync<WebhooksPluginOptions> = async (fastify, opts) => {
  const db = opts.db ?? prodDb;

  fastify.post<{ Body: AsaasWebhookBody }>('/webhooks/asaas', async (request, reply) => {
    const token = request.headers['asaas-access-token'];

    if (!isValidToken(token)) {
      return reply.status(401).send({ error: 'invalid_webhook_token' });
    }

    const { event, payment } = request.body ?? {};

    fastify.log.info({ event, paymentId: payment?.id, status: payment?.status }, 'asaas webhook');

    if (!event || !PAYMENT_RECEIVED_EVENTS.has(event) || !payment?.id) {
      return reply.status(200).send({ received: true });
    }

    const outcome = await processPaymentReceived(db, { asaasPaymentId: payment.id, rawEvent: request.body });

    if (outcome.kind === 'unknown_payment') {
      fastify.log.warn({ paymentId: payment.id }, 'asaas webhook for unknown local payment');
    } else if (outcome.kind === 'payment_conflict') {
      fastify.log.error(
        { paymentId: payment.id, reservationId: outcome.reservationId },
        'payment received after the room became unavailable — reservation moved to payment_conflict, refund is manual',
      );
    }

    if (
      (outcome.kind === 'confirmed' || outcome.kind === 'payment_conflict' || outcome.kind === 'payment_marked_received_only') &&
      outcome.overpaymentFlagged
    ) {
      fastify.log.error(
        { paymentId: payment.id, reservationId: outcome.reservationId },
        'payment received pushed balance_due_cents negative — flagged on the payment row, refund is manual',
      );
    }

    return reply.status(200).send({ received: true });
  });
};

export default webhooksPlugin;
