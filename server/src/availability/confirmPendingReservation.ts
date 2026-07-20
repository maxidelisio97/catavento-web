/**
 * Confirms a reservation once its deposit payment has been verified by an
 * Asaas webhook, per SPEC-modulo-4-pago-asaas.md § "Webhook Asaas".
 *
 * Runs inside the same anti-overbooking transaction pattern as módulo 2's
 * createReservation: lock the room row, re-check availability, then decide.
 * The "caso límite" (payment lands after expires_at): if the nights are
 * still available, confirm anyway (the guest paid, there's room); if not,
 * the reservation moves to `payment_conflict` instead of double-booking the
 * unit — refunds are handled manually for now (módulo 5 will surface these).
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { calculateAvailability } from './calculateAvailability.js';
import { fetchRoomStayData } from './repository.js';

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
      ? calculateAvailability({
          checkIn,
          checkOut,
          totalUnits: stayData.totalUnits,
          overrides: stayData.overrides,
          occupiedByDate: stayData.occupiedByDate,
        })
      : { available: false, nights: [], unitsLeft: 0 };

    if (availability.available) {
      await trx.updateTable('reservations').set({ status: 'confirmed' }).where('id', '=', reservation.id).execute();
      return { kind: 'confirmed', reservationId: reservation.id };
    }

    await trx
      .updateTable('reservations')
      .set({ status: 'payment_conflict' })
      .where('id', '=', reservation.id)
      .execute();
    return { kind: 'payment_conflict', reservationId: reservation.id };
  });
}
