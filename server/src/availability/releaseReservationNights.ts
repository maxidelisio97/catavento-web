/**
 * Single reusable "free this reservation's nights" function, per
 * SPEC-modulo-6-panel-base.md § "6A.2 Refactor de la asignación automática".
 *
 * Simple and unconditional: deletes every `reservation_nights` row for the
 * given reservation, regardless of its current status. Callers decide WHEN
 * it's correct to call this (e.g. `confirmPendingReservation.ts` calls it
 * when a reservation moves to `payment_conflict`); this function doesn't
 * re-check anything, it just deletes.
 *
 * IMPORTANT: any future module that needs to release a reservation's units
 * (e.g. a future cancellation flow in M7) MUST call this SAME function
 * rather than reimplementing the delete — this is the one place that knows
 * how to release reservation_nights rows.
 */
import type { Transaction } from 'kysely';
import type { DB } from '../db/types.js';

export async function releaseReservationNights(trx: Transaction<DB>, reservationId: number): Promise<void> {
  await trx.deleteFrom('reservation_nights').where('reservation_id', '=', reservationId).execute();
}
