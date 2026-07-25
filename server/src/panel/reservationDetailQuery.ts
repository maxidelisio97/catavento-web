/**
 * Read model for the panel's reservation detail, per
 * SPEC-modulo-6-panel-base.md § "6C.1 Endpoints de lectura" /
 * "GET /panel/reservations/:id".
 *
 * This endpoint is authenticated back-office only and DOES expose minors'
 * data (children ages, baby count) — the risk-review restriction from
 * módulo 4 applies to the public code-lookup GET, not to this one (SPEC
 * § 6C.1, explicit).
 */
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { eachNightUTC } from '../shared/dateUtils.js';

export interface ReservationDetail {
  id: number;
  code: string | null;
  status: string;
  arrival: string;
  departure: string;
  nights: number;
  room_type: { id: number; name: string };
  units: { night: string; unit_label: string }[];
  guests: {
    adults: number;
    children: number;
    children_ages: number[];
    babies: number;
    total: number;
  };
  pets: boolean;
  money: {
    total_cents: number;
    deposit_cents: number | null;
    pet_fee_cents: number;
    paid_cents: number;
    balance_cents: number;
  };
  origin: string;
  contact: { name: string | null; email: string | null; phone: string | null };
  comments: string | null;
  created_at: string;
}

export async function getReservationDetail(db: Kysely<DB>, id: number): Promise<ReservationDetail | null> {
  const reservation = await db
    .selectFrom('reservations')
    .innerJoin('rooms', 'rooms.id', 'reservations.room_id')
    .select([
      'reservations.id as id',
      'reservations.code as code',
      'reservations.status as status',
      sql<string>`reservations.check_in::text`.as('check_in'),
      sql<string>`reservations.check_out::text`.as('check_out'),
      'reservations.guests as guests',
      'reservations.children as children',
      'reservations.children_ages as children_ages',
      'reservations.babies as babies',
      'reservations.pets as pets',
      'reservations.total_cents as total_cents',
      'reservations.deposit_cents as deposit_cents',
      'reservations.pet_fee_cents as pet_fee_cents',
      'reservations.origin as origin',
      'reservations.guest_name as guest_name',
      'reservations.guest_email as guest_email',
      'reservations.guest_phone as guest_phone',
      'reservations.notes as notes',
      'reservations.created_at as created_at',
      'rooms.id as room_type_id',
      'rooms.name as room_type_name',
    ])
    .where('reservations.id', '=', id)
    .executeTakeFirst();

  if (!reservation) return null;

  const unitRows = await db
    .selectFrom('reservation_nights')
    .innerJoin('room_units', 'room_units.id', 'reservation_nights.room_unit_id')
    .select([sql<string>`reservation_nights.night::text`.as('night'), 'room_units.label as unit_label'])
    .where('reservation_nights.reservation_id', '=', id)
    .orderBy('reservation_nights.night')
    .execute();

  const paidRow = await db
    .selectFrom('payments')
    .select(sql<string>`coalesce(sum(amount_cents), 0)`.as('paid_cents'))
    .where('reservation_id', '=', id)
    .where('status', '=', 'received')
    .executeTakeFirst();

  const paidCents = Number(paidRow?.paid_cents ?? 0);
  const totalCents = reservation.total_cents;

  return {
    id: reservation.id,
    code: reservation.code,
    status: reservation.status,
    arrival: reservation.check_in,
    departure: reservation.check_out,
    // Derived from the stay's own dates, not from reservation_nights row
    // count — a cancelled/expired reservation no longer has any rows (see
    // releaseReservationNights.ts), but its original stay length is still a
    // valid thing to show in the detail panel.
    nights: eachNightUTC(reservation.check_in, reservation.check_out).length,
    room_type: { id: reservation.room_type_id, name: reservation.room_type_name },
    units: unitRows.map((row) => ({ night: row.night, unit_label: row.unit_label })),
    guests: {
      adults: reservation.guests - reservation.children,
      children: reservation.children,
      children_ages: reservation.children_ages,
      babies: reservation.babies,
      // SPEC § 6C.1 example: adults 2 + children 1 = total 3, babies 0 kept
      // separate — matches `reservations.guests`, which never counts babies
      // (see plugins/reservations.ts's capacity comment).
      total: reservation.guests,
    },
    pets: reservation.pets,
    money: {
      total_cents: totalCents,
      deposit_cents: reservation.deposit_cents,
      pet_fee_cents: reservation.pet_fee_cents,
      paid_cents: paidCents,
      balance_cents: totalCents - paidCents,
    },
    origin: reservation.origin,
    contact: {
      name: reservation.guest_name,
      email: reservation.guest_email,
      phone: reservation.guest_phone,
    },
    comments: reservation.notes,
    created_at: new Date(reservation.created_at).toISOString(),
  };
}
