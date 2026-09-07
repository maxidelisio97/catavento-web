/**
 * POST /webhooks/channex — SPEC-modulo-12B-reservas-entrantes.md § 3.2.
 * Same shape as the Asaas webhook (webhooks.ts): a raw HTTP endpoint, no
 * `requirePermission` (this runs as a system process, not a logged-in user
 * — § 5), secret verified via the shared `isValidWebhookSecret` (§ 3.3).
 *
 * Channex's hard rule (§ 3.2, quoted in the spec): respond with a success
 * status code even if processing surfaces an overbooking on our side — the
 * `ota_conflict` path IS how that's honored without lying about the result;
 * Channex only needs to know the delivery was received, not what we did
 * with it. The one thing that still returns non-200 is a bad secret (never
 * a body/processing detail).
 */
import type { FastifyPluginAsync } from 'fastify';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { config } from '../config.js';
import { isValidWebhookSecret } from './verifyWebhookSecret.js';
import { parseChannexBookingRevision } from '../channex/channexPayload.js';
import { processBookingRevision } from '../channex/processBookingRevision.js';
import { ackBookingRevision } from '../channex/channexClient.js';
import { shouldAck } from '../channex/pullBookingRevisions.js';

// Header name is ours to choose (§ 3.3: Channex doesn't sign webhooks, it
// just echoes back whatever custom header we configure on their side) — set
// the SAME name in the Webhook Collection config on Channex (Organization →
// Property/Global Webhooks → headers).
const WEBHOOK_SECRET_HEADER = 'x-channex-webhook-secret';

export interface WebhooksChannexPluginOptions {
  /** Overridable for tests — production uses the shared db client by default. */
  db?: Kysely<DB>;
}

const webhooksChannexPlugin: FastifyPluginAsync<WebhooksChannexPluginOptions> = async (fastify, opts) => {
  const db = opts.db ?? prodDb;

  fastify.post('/webhooks/channex', async (request, reply) => {
    const secret = request.headers[WEBHOOK_SECRET_HEADER];

    if (!config.channex.webhookSecret || !isValidWebhookSecret(secret, config.channex.webhookSecret)) {
      return reply.status(401).send({ error: 'invalid_webhook_secret' });
    }

    const parsed = parseChannexBookingRevision(request.body);

    if (!parsed) {
      // Still 200: an unparseable payload is our problem to fix
      // (channexPayload.ts), not something Channex should retry forever for.
      // Risk-review finding: never log the raw body here — it can carry
      // guest PII (name/email/phone) even when required fields are missing
      // (server/CLAUDE.md's M4 lesson on PII leaking through logs applies
      // just as much to a new module). Log only structural diagnostics.
      fastify.log.warn(
        { topLevelKeys: typeof request.body === 'object' && request.body !== null ? Object.keys(request.body) : typeof request.body },
        'channex webhook: payload could not be parsed',
      );
      return reply.status(200).send({ received: true });
    }

    try {
      const outcome = await processBookingRevision(db, parsed);
      fastify.log.info({ bookingId: parsed.bookingId, revisionId: parsed.revisionId, outcome }, 'channex webhook processed');

      if (shouldAck(outcome)) {
        await ackBookingRevision(parsed.revisionId).catch((err) =>
          fastify.log.error({ err, revisionId: parsed.revisionId }, 'channex webhook: ack failed'),
        );
      } else {
        // unmapped_room_type / multi_room_unsupported: deliberately left
        // un-acked (see pullBookingRevisions.ts's shouldAck doc comment) —
        // Channex's own 30-minute "não confirmado" email becomes a second
        // signal that a mapping/config problem needs a human.
        fastify.log.error({ bookingId: parsed.bookingId, outcome }, 'channex webhook: not acked, needs manual attention');
      }
    } catch (err) {
      // § 3.2: never let a processing error surface as a non-200 to
      // Channex — log it loudly instead. The pull (§ 3.4) will retry this
      // same revision from the feed since it was never acked.
      fastify.log.error({ err, bookingId: parsed.bookingId, revisionId: parsed.revisionId }, 'channex webhook: processing failed');
    }

    return reply.status(200).send({ received: true });
  });
};

export default webhooksChannexPlugin;
