/**
 * Confirms a reservation once its deposit payment has been verified by an
 * Asaas webhook, per SPEC-modulo-4-pago-asaas.md § "Webhook Asaas".
 *
 * Runs inside the same anti-overbooking transaction pattern as módulo 2's
 * createReservation: lock the room row, re-check availability, then decide.
 * The "caso límite" (payment lands after expires_at): if a physical unit is
 * still free for the whole stay, confirm anyway (the guest paid, there's
 * room) and (re)write its `reservation_nights` rows; if not, the reservation
 * moves to `payment_conflict` instead of double-booking the unit — refunds
 * are handled manually for now (módulo 5 will surface these).
 *
 * Módulo 6A note: the re-check MUST be per-unit
 * (`calculateCombinedAvailability`), not just the aggregate
 * `calculateAvailability`. A pending hold that already expired can have had
 * its `reservation_nights` rows deleted by another transaction's lazy sweep
 * (sweepStaleReservationNights.ts) in the meantime — the aggregate check
 * alone can't tell whether a physical unit is actually still free for this
 * exact reservation, and confirming without restoring its rows would leave
 * an active reservation with zero units assigned, breaking the § 6A.3
 * invariant. `fetchRoomStayData`'s `excludeReservationId` already ignores
 * this reservation's own (possibly stale, possibly absent) rows, so
 * `freeUnits` reflects everyone ELSE'S occupancy — exactly what's needed to
 * decide "is there still a unit for it", regardless of what state this
 * reservation's own rows happen to be in right now.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { calculateCombinedAvailability } from './combinedAvailability.js';
import { fetchRoomStayData } from './repository.js';
import { releaseReservationNights } from './releaseReservationNights.js';
import { eachNightUTC } from '../shared/dateUtils.js';
import { assertReservationNightsConsistency } from './checkReservationNightsConsistency.js';

export type ConfirmOutcome =
  /** Payment row didn't exist locally — nothing to do (ack the webhook anyway). */
  | { kind: 'unknown_payment' }
  /** Same event/status already fully processed — no side effects applied. */
  | { kind: 'noop_idempotent' }
  /** Payment marked received, but the reservation was already settled by another path. */
  | { kind: 'payment_marked_received_only'; reservationId: number; reservationStatus: string }
  /** Reservation moved pending_payment -> confirmed. */
  | { kind: 'confirmed'; reservationId: number }
  /** Reservation moved pending_payment -> payment_conflict (see module docstring). */
  | { kind: 'payment_conflict'; reservationId: number };

export interface ProcessPaymentReceivedInput {
  asaasPaymentId: string;
  rawEvent: unknown;
}

export async function processPaymentReceived(
  db: Kysely<DB>,
  input: ProcessPaymentReceivedInput,
): Promise<ConfirmOutcome> {
  return db.transaction().execute(async (trx) => {
    const payment = await trx
      .selectFrom('payments')
      .selectAll()
      .where('asaas_payment_id', '=', input.asaasPaymentId)
      .forUpdate()
      .executeTakeFirst();

    if (!payment) {
      return { kind: 'unknown_payment' };
    }

    // Lock the reservation row itself so a duplicate/near-simultaneous
    // webhook delivery can't race this one.
    const reservation = await trx
      .selectFrom('reservations')
      .select([
        'id',
        'room_id',
        'status',
        sql<string>`check_in::text`.as('check_in'),
        sql<string>`check_out::text`.as('check_out'),
      ])
      .where('id', '=', payment.reservation_id)
      .forUpdate()
      .executeTakeFirst();

    if (!reservation) {
      return { kind: 'unknown_payment' };
    }

    const alreadyReceived = payment.status === 'received';
    const reservationSettled = reservation.status !== 'pending_payment';

    if (alreadyReceived && reservationSettled) {
      // Idempotency: this exact outcome was already applied by a previous
      // delivery of this (or an equivalent) webhook event.
      return { kind: 'noop_idempotent' };
    }

    if (!alreadyReceived) {
      await trx
        .updateTable('payments')
        .set({ status: 'received', raw_last_event: JSON.stringify(input.rawEvent), updated_at: new Date() })
        .where('id', '=', payment.id)
        .execute();
    }

    if (reservationSettled) {
      // Reservation was already confirmed/cancelled/payment_conflict by
      // another path (e.g. a previous webhook delivery that crashed after
      // updating the payment but before this point). Nothing more to do.
      return {
        kind: 'payment_marked_received_only',
        reservationId: reservation.id,
        reservationStatus: reservation.status,
      };
    }

    // Re-lock the room and recompute availability excluding this
    // reservation's own occupancy, so we're checking "is there still room
    // for it", not "does it collide with itself".
    const room = await trx
      .selectFrom('rooms')
      .select('id')
      .where('id', '=', reservation.room_id)
      .forUpdate()
      .executeTakeFirst();

    const checkIn = reservation.check_in;
    const checkOut = reservation.check_out;

    const stayData = room
      ? await fetchRoomStayData(trx, reservation.room_id, checkIn, checkOut, reservation.id)
      : undefined;

    const availability = stayData
      ? calculateCombinedAvailability({
          checkIn,
          checkOut,
          totalUnits: stayData.totalUnits,
          overrides: stayData.overrides,
          occupiedByDate: stayData.occupiedByDate,
          units: stayData.roomUnits,
          unitReservations: stayData.unitReservations,
        })
      : { available: false, nights: [], unitsLeft: 0, freeUnits: [] };

    const chosenUnit = availability.available ? availability.freeUnits[0] : undefined;

    if (availability.available && chosenUnit) {
      // Restore this reservation's reservation_nights from scratch rather
      // than trying to diff against whatever partial/stale state they're
      // currently in (0 rows if swept, all of them if untouched, anything
      // in between is not expected but not worth reasoning about either) —
      // delete-then-reinsert is simple and always correct here.
      await releaseReservationNights(trx, reservation.id);
      await trx
        .insertInto('reservation_nights')
        .values(
          eachNightUTC(checkIn, checkOut).map((night) => ({
            reservation_id: reservation.id,
            night,
            room_unit_id: chosenUnit.id,
          })),
        )
        .execute();

      await trx
        .updateTable('reservations')
        .set({ status: 'confirmed', room_unit_id: chosenUnit.id })
        .where('id', '=', reservation.id)
        .execute();

      await assertReservationNightsConsistency(trx, reservation.id);

      return { kind: 'confirmed', reservationId: reservation.id };
    }

    await trx
      .updateTable('reservations')
      .set({ status: 'payment_conflict' })
      .where('id', '=', reservation.id)
      .execute();

    // Módulo 6A: the reservation no longer occupies inventory once it's
    // marked payment_conflict, so its reservation_nights rows must go too —
    // otherwise the unit would stay "occupied" in the per-night model
    // forever, with nothing left to ever release it (unlike a normal
    // pending_payment expiry, which the lazy sweep picks up on the next
    // createReservation for that room). A future cancellation flow (M7)
    // must call this SAME function rather than reimplementing the delete.
    await releaseReservationNights(trx, reservation.id);

    await assertReservationNightsConsistency(trx, reservation.id);

    return { kind: 'payment_conflict', reservationId: reservation.id };
  });
}
