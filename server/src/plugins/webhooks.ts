import type { FastifyPluginAsync } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

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

const webhooksPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: AsaasWebhookBody }>('/webhooks/asaas', async (request, reply) => {
    const token = request.headers['asaas-access-token'];

    if (!isValidToken(token)) {
      return reply.status(401).send({ error: 'invalid_webhook_token' });
    }

    const { event, payment } = request.body ?? {};

    // TODO: persist payment status transitions once module 3 (reservation
    // flow) defines where reservation state lives.
    fastify.log.info({ event, paymentId: payment?.id, status: payment?.status }, 'asaas webhook');

    return reply.status(200).send({ received: true });
  });
};

export default webhooksPlugin;
