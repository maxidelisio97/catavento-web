/**
 * POST /webhooks/channex — SPEC-modulo-12B-reservas-entrantes.md § 3.2.
 * Same shape as the Asaas webhook (webhooks.ts): a raw HTTP endpoint, no
 * `requirePermission` (this runs as a system process, not a logged-in user
 * — § 5), secret verified via the shared `isValidWebhookSecret` (§ 3.3).
 *
 * VERIFIED LIVE against staging.channex.io on 2026-09-08 (real webhook
 * delivery, not just docs): the "booking" trigger — the single-select
 * option Channex's own "Create Webhook" UI actually offers, as opposed to
 * the API docs' `event_mask` multi-value description — sends ONLY
 * `{ event: "booking", property_id, user_id, timestamp }`. NO `booking_id`
 * or `revision_id` anywhere, not even nested (an earlier version of this
 * file assumed a `payload: {booking_id, revision_id}` field per the
 * published docs; that assumption was wrong for this trigger and has been
 * corrected here after capturing the real body).
 *
 * Given there's no identifier to fetch a specific revision by, this
 * confirms Channex's own stated design intent literally: "This event was
 * originally designed to trigger a Pull booking revision operation from
 * the PMS." So this handler does exactly that — it reuses
 * `pullBookingRevisions` (§ 3.4, the SAME function the panel's manual
 * "Buscar reservas agora" button calls) instead of fetching one revision
 * by id. This is simpler than the id-based design it replaces AND correct
 * regardless of whether Channex ever adds an identifier to this payload —
 * a full feed pull processes whatever is actually new/unacked, no matter
 * how the webhook told us to go look.
 *
 * Channex's hard rule (§ 3.2, quoted in the spec): respond with a success
 * status code even if processing surfaces an overbooking on our side — the
 * `ota_conflict` path IS how that's honored without lying about the result;
 * Channex only needs to know the delivery was received, not what we did
 * with it. The one thing that still returns non-200 is a bad secret (never
 * a body/processing detail, and NOT a failure of the pull itself below —
 * that's just as much "our problem" as any other processing failure).
 */
import type { FastifyPluginAsync } from 'fastify';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { db as prodDb } from '../db/client.js';
import { config } from '../config.js';
import { isValidWebhookSecret } from './verifyWebhookSecret.js';
import { pullBookingRevisions } from '../channex/pullBookingRevisions.js';

// Header name is ours to choose (§ 3.3: Channex doesn't sign webhooks, it
// just echoes back whatever custom header we configure on their side) — set
// the SAME name in the Webhook Collection config on Channex (Organization →
// Property/Global Webhooks → headers).
const WEBHOOK_SECRET_HEADER = 'x-channex-webhook-secret';

// Accepts the generic "booking" trigger (confirmed live — see docstring)
// AND the three specific ones from the API docs, in case a webhook is ever
// configured either way — this handler doesn't need per-event branching
// either way, it always just triggers a full pull for the property.
const WEBHOOK_EVENTS = new Set(['booking', 'booking_new', 'booking_modification', 'booking_cancellation']);

interface WebhookEnvelope {
  propertyId: string;
}

/** The webhook's own real, confirmed-live shape — see this file's docstring. */
function parseWebhookEnvelope(raw: unknown): WebhookEnvelope | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as { event?: string; property_id?: string };
  if (!body.event || !WEBHOOK_EVENTS.has(body.event)) return null;
  if (typeof body.property_id !== 'string' || !body.property_id) return null;

  return { propertyId: body.property_id };
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
      // body — confirmed to carry no PII for this trigger, but a future
      // Channex change to its shape shouldn't require re-litigating that.
      fastify.log.warn(
        { topLevelKeys: typeof request.body === 'object' && request.body !== null ? Object.keys(request.body) : typeof request.body },
        'channex webhook: envelope could not be parsed',
      );
      return reply.status(200).send({ received: true });
    }

    try {
      const result = await pullBookingRevisions(db, envelope.propertyId);
      fastify.log.info(
        { propertyId: envelope.propertyId, totalFeedItems: result.totalFeedItems, items: result.items.map((i) => i.outcome) },
        'channex webhook: pull triggered',
      );
    } catch (err) {
      // § 3.2: never let a processing error surface as a non-200 to
      // Channex. The next webhook delivery, or a manual pull, will pick up
      // whatever this attempt didn't get to.
      fastify.log.error({ err, propertyId: envelope.propertyId }, 'channex webhook: pull failed');
    }

    return reply.status(200).send({ received: true });
  });
};

export default webhooksChannexPlugin;
