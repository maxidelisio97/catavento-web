import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export const webhooksRouter = Router();

function isValidToken(receivedToken) {
  if (typeof receivedToken !== 'string') return false;

  const expected = Buffer.from(config.asaas.webhookToken);
  const received = Buffer.from(receivedToken);

  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

webhooksRouter.post('/webhooks/asaas', (req, res) => {
  const token = req.header('asaas-access-token');

  if (!isValidToken(token)) {
    return res.status(401).json({ error: 'invalid_webhook_token' });
  }

  const { event, payment } = req.body ?? {};

  // TODO: persist payment status transitions once the booking flow defines
  // where reservation state lives (DB, HQBeds callback, etc).
  console.log('[asaas webhook]', event, payment?.id, payment?.status);

  res.status(200).json({ received: true });
});
