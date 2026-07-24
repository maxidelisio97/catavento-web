/**
 * Read model backing the "Cambiar de cuarto" selector (SPEC-modulo-7 § 4.5):
 * for a reservation's stay, which active units are free for which of its
 * nights. Cross-room-type on purpose — the spec doesn't restrict a move to
 * the same room type (an upgrade/downgrade is a legitimate operator move),
 * so every active unit is listed with its own commercial fit (capacity,
 * adults_only) left for the frontend to display and for
 * moveNight/moveStay's own check to enforce authoritatively.
 *
 * PURELY INFORMATIONAL — this is a snapshot at read time, not a hold. The
 * unit can be taken by someone else between this read and the operator's
 * confirm; moveNight/moveStay re-validates from scratch and is the only
 * source of truth. Callers must treat a 409 from move as "refresh this list
 * and try again", never assume this endpoint reserved anything.
 */
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { isReservationActive } from '../availability/isReservationActive.js';
import { eachNightUTC } from '../shared/dateUtils.js';

export interface MoveOptionUnit {
  unit_id: number;
  unit_label: string;
  room_type_id: number;
  room_type_name: string;
  capacity: number;
  adults_only: boolean;
  /** Nights (of the reservation's own stay) already occupied by another active reservation. */
  occupied_nights: string[];
  free_for_all_nights: boolean;
}

export interface MoveOptions {
  nights: string[];
  units: MoveOptionUnit[];
}

export async function getMoveOptions(db: Kysely<DB>, code: string): Promise<MoveOptions | null> {
  const reservation = await db
    .selectFrom('reservations')
    .select(['id', sql<string>`check_in::text`.as('check_in'), sql<string>`check_out::text`.as('check_out')])
    .where('code', '=', code)
    .executeTakeFirst();

  if (!reservation) return null;

  const nights = eachNightUTC(reservation.check_in, reservation.check_out);

  const unitRows = await db
    .selectFrom('room_units')
    .innerJoin('rooms', 'rooms.id', 'room_units.room_id')
    .select([
      'room_units.id as unit_id',
      'room_units.label as unit_label',
      'rooms.id as room_type_id',
      'rooms.name as room_type_name',
      'rooms.capacity as capacity',
      'rooms.adults_only as adults_only',
    ])
    .where('room_units.active', '=', true)
    .orderBy('rooms.sort_order')
    .orderBy('room_units.label')
    .execute();

  const occupancyRows = await db
    .selectFrom('reservation_nights')
    .innerJoin('reservations', 'reservations.id', 'reservation_nights.reservation_id')
    .select([
      'reservation_nights.room_unit_id as room_unit_id',
      sql<string>`reservation_nights.night::text`.as('night'),
      'reservations.status as status',
      'reservations.expires_at as expires_at',
    ])
    .where('reservation_nights.night', '>=', sql<Date>`${reservation.check_in}::date`)
    .where('reservation_nights.night', '<', sql<Date>`${reservation.check_out}::date`)
    .where('reservation_nights.reservation_id', '!=', reservation.id)
    .execute();

  const occupiedByUnit = new Map<number, string[]>();
  for (const row of occupancyRows) {
    if (!isReservationActive(row.status, row.expires_at)) continue;
    const list = occupiedByUnit.get(row.room_unit_id) ?? [];
    list.push(row.night);
    occupiedByUnit.set(row.room_unit_id, list);
  }

  return {
    nights,
    units: unitRows.map((u) => {
      const occupied = occupiedByUnit.get(u.unit_id) ?? [];
      return {
        unit_id: u.unit_id,
        unit_label: u.unit_label,
        room_type_id: u.room_type_id,
        room_type_name: u.room_type_name,
        capacity: u.capacity,
        adults_only: u.adults_only,
        occupied_nights: occupied,
        free_for_all_nights: occupied.length === 0,
      };
    }),
  };
}
