/**
 * Lazy sweep of stale `reservation_nights` rows, per
 * SPEC-modulo-6-panel-base.md § "6A.2 Refactor de la asignación automática".
 *
 * "Stale" means: the row's parent reservation is no longer active per
 * `isReservationActive` (expired pending_payment, or cancelled) but its
 * `reservation_nights` rows haven't been cleaned up yet — e.g. a hold that
 * expired without anyone calling `releaseReservationNights` for it yet.
 *
 * Scope is deliberately narrow: only `room_units` belonging to `roomId`, and
 * only nights within the exact requested `[checkIn, checkOut)` range — never
 * the whole room's history, never all time. This keeps the sweep cheap and
 * bounded to the availability window actually being decided.
 *
 * WHY THIS IS RACE-SAFE: this function is only ever called from
 * `createReservation` INSIDE its transaction, AFTER that transaction has
 * already acquired the `rooms` row `FOR UPDATE` lock for this exact
 * `roomId`. That lock already serializes every `createReservation` call for
 * this room — no concurrent call for the same room can interleave a sweep
 * from one transaction with an insert from another. The sweep, the
 * availability check, and the eventual insert all happen under the same
 * lock, in the same transaction.
 */
import { sql, type Transaction } from 'kysely';
import type { DB } from '../db/types.js';
import { isReservationActive } from './isReservationActive.js';

export async function sweepStaleReservationNights(
  trx: Transaction<DB>,
  roomId: number,
  checkIn: string,
  checkOut: string,
): Promise<void> {
  const rows = await trx
    .selectFrom('reservation_nights')
    .innerJoin('room_units', 'room_units.id', 'reservation_nights.room_unit_id')
    .innerJoin('reservations', 'reservations.id', 'reservation_nights.reservation_id')
    .select([
      'reservation_nights.id as id',
      'reservations.status as status',
      'reservations.expires_at as expires_at',
    ])
    .where('room_units.room_id', '=', roomId)
    // Plain 'YYYY-MM-DD' strings cast in SQL, never a JS Date object — same
    // timezone-safety rationale as repository.ts's overrideRows query.
    .where('reservation_nights.night', '>=', sql<Date>`${checkIn}::date`)
    .where('reservation_nights.night', '<', sql<Date>`${checkOut}::date`)
    .execute();

  const staleIds = rows.filter((row) => !isReservationActive(row.status, row.expires_at)).map((row) => row.id);

  if (staleIds.length === 0) return;

  await trx.deleteFrom('reservation_nights').where('id', 'in', staleIds).execute();
}
