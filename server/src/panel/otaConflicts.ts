/**
 * § 3.5 — manual resolution of an `ota_conflict` reservation. Reuses
 * `reassignOtaReservation` (channex/processBookingRevision.ts), the SAME
 * lock+recompute+reassign transaction the modification path uses — a retry
 * is exactly "recompute availability for this reservation's current dates
 * and try again", no separate logic needed.
 */
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { reassignOtaReservation } from '../channex/processBookingRevision.js';

export class ReservationNotFoundError extends Error {
  constructor() {
    super('Reservation not found');
  }
}

export class ReservationNotInConflictError extends Error {
  constructor(readonly status: string) {
    super(`Reservation is '${status}', not 'ota_conflict'`);
  }
}

export interface RetryOtaConflictResult {
  resolved: boolean;
}

export interface OtaConflictSummary {
  id: number;
  code: string | null;
  roomName: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  guestName: string | null;
  totalCents: number;
}

/**
 * § 6: the tape chart can't show these — it's keyed entirely off
 * `reservation_nights` (unit × night), and an `ota_conflict` reservation has
 * NO rows there by design (§ 0.1). This is the one place an operator can
 * actually see and act on a conflict.
 */
export async function listOtaConflicts(db: Kysely<DB>): Promise<OtaConflictSummary[]> {
  const rows = await db
    .selectFrom('reservations')
    .innerJoin('rooms', 'rooms.id', 'reservations.room_id')
    .select([
      'reservations.id as id',
      'reservations.code as code',
      'rooms.name as roomName',
      'reservations.guests as guests',
      'reservations.guest_name as guestName',
      'reservations.total_cents as totalCents',
      sql<string>`reservations.check_in::text`.as('checkIn'),
      sql<string>`reservations.check_out::text`.as('checkOut'),
    ])
    .where('reservations.status', '=', 'ota_conflict')
    .orderBy('reservations.check_in')
    .execute();

  return rows;
}

export async function retryOtaConflict(db: Kysely<DB>, reservationId: number): Promise<RetryOtaConflictResult> {
  const reservation = await db
    .selectFrom('reservations')
    .select([
      'id',
      'status',
      'room_id',
      'guests',
      'override_total_cents',
      'guest_name',
      'guest_email',
      'guest_phone',
      sql<string>`check_in::text`.as('check_in'),
      sql<string>`check_out::text`.as('check_out'),
    ])
    .where('id', '=', reservationId)
    .executeTakeFirst();

  if (!reservation) throw new ReservationNotFoundError();
  if (reservation.status !== 'ota_conflict') throw new ReservationNotInConflictError(reservation.status);

  // Not sent to Channex: a retry that resolves the conflict changes OUR
  // inventory picture, not what Channex thinks happened to the booking — the
  // `channex_last_revision_id` stays whatever the last Channex-driven write
  // set it to (channexRevisionId omitted below).
  const { available } = await reassignOtaReservation(db, {
    reservationId: reservation.id,
    roomId: reservation.room_id,
    checkIn: reservation.check_in,
    checkOut: reservation.check_out,
    guests: reservation.guests,
    amountCents: reservation.override_total_cents,
    guestName: reservation.guest_name,
    guestEmail: reservation.guest_email,
    guestPhone: reservation.guest_phone,
  });

  return { resolved: available };
}
