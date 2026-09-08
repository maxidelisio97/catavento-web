/**
 * Booking Revisions Feed pull — SPEC-modulo-12B-reservas-entrantes.md § 3.4.
 * Reuses `processBookingRevision` (§ 3.1), same as the webhook — this is
 * only "where the payload comes from" and "ack afterwards", never its own
 * copy of the create/modify/cancel logic.
 *
 * 12B scope (§ 9, confirmed): triggered by hand from the panel, no cron yet
 * — 12D adds the automated schedule.
 */
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { fetchBookingRevisionsFeed, ackBookingRevision } from './channexClient.js';
import { parseChannexBookingRevision } from './channexPayload.js';
import { processBookingRevision, type ProcessBookingRevisionOutcome } from './processBookingRevision.js';

export type PullItemOutcome = ProcessBookingRevisionOutcome | { kind: 'unparseable' } | { kind: 'error'; message: string };

export interface PullResultItem {
  outcome: PullItemOutcome;
  acked: boolean;
}

export interface PullBookingRevisionsResult {
  totalFeedItems: number;
  items: PullResultItem[];
}

/**
 * Whether processing this outcome resolved the revision enough to ack it.
 * `unmapped_room_type`/`multi_room_unsupported` are deliberately left
 * UN-acked: Channex keeps re-serving them, and its own 30-minute
 * "não confirmado" email is a useful second signal that a mapping/config
 * problem needs a human, not a silent drop.
 */
export function shouldAck(outcome: PullItemOutcome): boolean {
  return (
    outcome.kind !== 'unmapped_room_type' &&
    outcome.kind !== 'multi_room_unsupported' &&
    outcome.kind !== 'unparseable' &&
    outcome.kind !== 'error'
  );
}

export async function pullBookingRevisions(db: Kysely<DB>, propertyId: string): Promise<PullBookingRevisionsResult> {
  const rawItems = await fetchBookingRevisionsFeed(propertyId);
  const items: PullResultItem[] = [];

  for (const raw of rawItems) {
    // Risk-review finding (pre-merge, fresh-context review): a single
    // problematic feed item (a genuine processing error — parseChannex-
    // BookingRevision itself never throws, see its own docstring) must not
    // abort the rest of this batch — every OTHER, unrelated booking's
    // create/modify/cancel in the same pull still needs to go through.
    let outcome: PullItemOutcome;
    let revisionId: string | undefined;
    try {
      const parsed = parseChannexBookingRevision(raw);
      revisionId = parsed?.revisionId;
      outcome = parsed ? await processBookingRevision(db, parsed) : { kind: 'unparseable' };
    } catch (err) {
      outcome = { kind: 'error', message: err instanceof Error ? err.message : 'unknown error' };
    }

    // The revision's own id (parsed.revisionId, confirmed == the feed
    // item's JSON:API resource id — see channexPayload.ts's docstring) is
    // what `ackBookingRevision` expects. Nothing to ack if parsing failed
    // before that id was even extracted.
    let acked = false;
    if (shouldAck(outcome) && revisionId) {
      await ackBookingRevision(revisionId);
      acked = true;
    }

    items.push({ outcome, acked });
  }

  return { totalFeedItems: rawItems.length, items };
}
