/**
 * POST /webhooks/channex — SPEC-modulo-12B-reservas-entrantes.md § 3.2.
 * Same shape as the Asaas webhook (webhooks.ts): a raw HTTP endpoint, no
 * `requirePermission` (this runs as a system process, not a logged-in user
 * — § 5), secret verified via the shared `isValidWebhookSecret` (§ 3.3).
 *
 * VERIFIED against Channex's published docs (docs.channex.io, "Webhook
 * Collection", checked 2026-09-07): the webhook body carries ONLY
 * identifiers — `{ event, payload: { booking_id, property_id, revision_id },
 * property_id, user_id, timestamp }` — no room/date/guest/amount details.
 * Quoting the docs directly: "This event was originally designed to
 * trigger a Pull booking revision operation from the PMS... we expect the
 * PMS will call `api/v1/booking_revisions/:id`, to pull the new revision
 * and ack it." So this handler fetches the full revision via
 * `getBookingRevision` BEFORE it can call `parseChannexBookingRevision` —
 * that parser only ever sees a full revision resource (from this fetch or
 * from a feed item), never the webhook's own minimal envelope.
 *
 * Channex's hard rule (§ 3.2, quoted in the spec): respond with a success
 * status code even if processing surfaces an overbooking on our side — the
 * `ota_conflict` path IS how that's honored without lying about the result;
 * Channex only needs to know the delivery was received, not what we did
 * with it. The one thing that still returns non-200 is a bad secret (never
 * a body/processing detail, and NOT a failure to reach Channex's own API
 * for the pull-by-id step below — that's just as much "our problem" as any
 * other processing failure).
 */
import type { FastifyPluginAsync } from 'fastify';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { config } from '../config.js';
import { isValidWebhookSecret } from './verifyWebhookSecret.js';
import { parseChannexBookingRevision } from '../channex/channexPayload.js';
import { processBookingRevision } from '../channex/processBookingRevision.js';
import { getBookingRevision, ackBookingRevision } from '../channex/channexClient.js';
import { shouldAck } from '../channex/pullBookingRevisions.js';

// Header name is ours to choose (§ 3.3: Channex doesn't sign webhooks, it
// just echoes back whatever custom header we configure on their side) — set
// the SAME name in the Webhook Collection config on Channex (Organization →
// Property/Global Webhooks → headers).
const WEBHOOK_SECRET_HEADER = 'x-channex-webhook-secret';

// Channex's "Create Webhook" UI (staging, checked 2026-09-08) offers a
// single-select "Trigger" dropdown, not a multi-select event_mask like the
// API docs describe — so this accepts BOTH the generic "booking" trigger
// (fires for any revision: new/modified/cancelled, per docs.channex.io's
// Webhook Collection page) AND the three specific ones, in case a webhook
// is ever configured either way. This handler doesn't branch on `event`
// itself regardless — it always fetches the full revision by id and reads
// ITS OWN `status` attribute, so accepting a broader set of trigger names
// here is risk-free.
const WEBHOOK_EVENTS = new Set(['booking', 'booking_new', 'booking_modification', 'booking_cancellation']);

interface WebhookEnvelope {
  bookingId: string;
  revisionId: string;
}

/** The webhook's own minimal shape — see this file's docstring for the confirmed real example. */
function parseWebhookEnvelope(raw: unknown): WebhookEnvelope | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as { event?: string; payload?: { booking_id?: string; revision_id?: string } };
  if (!body.event || !WEBHOOK_EVENTS.has(body.event)) return null;

  const bookingId = body.payload?.booking_id;
  const revisionId = body.payload?.revision_id;
  if (typeof bookingId !== 'string' || !bookingId || typeof revisionId !== 'string' || !revisionId) return null;

  return { bookingId, revisionId };
}

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

    const envelope = parseWebhookEnvelope(request.body);

    if (!envelope) {
      // Still 200: an unrecognized envelope is our problem to fix, not
      // something Channex should retry forever for. Never log the raw
      // body — even this minimal envelope carries no PII, but a future
      // Channex change to its shape shouldn't require re-litigating that.
      fastify.log.warn(
        { topLevelKeys: typeof request.body === 'object' && request.body !== null ? Object.keys(request.body) : typeof request.body },
        'channex webhook: envelope could not be parsed',
      );
      return reply.status(200).send({ received: true });
    }

    const { bookingId, revisionId } = envelope;

    try {
      const revision = await getBookingRevision(revisionId);
      const parsed = parseChannexBookingRevision(revision);

      if (!parsed) {
        fastify.log.warn({ bookingId, revisionId }, 'channex webhook: fetched revision could not be parsed');
        return reply.status(200).send({ received: true });
      }

      const outcome = await processBookingRevision(db, parsed);
      fastify.log.info({ bookingId, revisionId, outcome }, 'channex webhook processed');

      if (shouldAck(outcome)) {
        await ackBookingRevision(revisionId).catch((err) => fastify.log.error({ err, revisionId }, 'channex webhook: ack failed'));
      } else {
        // unmapped_room_type / multi_room_unsupported: deliberately left
        // un-acked (see pullBookingRevisions.ts's shouldAck doc comment) —
        // Channex's own 30-minute "não confirmado" email becomes a second
        // signal that a mapping/config problem needs a human.
        fastify.log.error({ bookingId, outcome }, 'channex webhook: not acked, needs manual attention');
      }
    } catch (err) {
      // § 3.2: never let a processing error — including a failure to reach
      // Channex's own API for the pull-by-id step — surface as a non-200.
      // The pull (§ 3.4) will retry this same revision from the feed since
      // it was never acked.
      fastify.log.error({ err, bookingId, revisionId }, 'channex webhook: processing failed');
    }

    return reply.status(200).send({ received: true });
  });
};

export default webhooksChannexPlugin;
