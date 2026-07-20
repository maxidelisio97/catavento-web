import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../db/types.js';
import { eachNightUTC, parseDateUTC } from '../shared/dateUtils.js';

export interface RoomStayData {
  roomId: number;
  name: string;
  capacity: number;
  totalUnits: number;
  defaultMinStay: number;
  roomRates: { occupancy: number; weekdayCents: number; weekendCents: number }[];
  overrides: {
    date: string;
    unitsAvailable: number | null;
    closed: boolean;
    priceCents: number | null;
    minStay: number | null;
  }[];
  /** Count of active reservations per night ('YYYY-MM-DD' -> count). */
  occupiedByDate: Record<string, number>;
}

/**
 * Fetches everything needed to compute availability and price for a room
 * over [checkIn, checkOut). Pass a `Transaction<DB>` to read with the
 * isolation of an in-flight transaction (used by createReservation).
 */
export async function fetchRoomStayData(
  executor: Kysely<DB> | Transaction<DB>,
  roomId: number,
  checkIn: string,
  checkOut: string,
): Promise<RoomStayData | undefined> {
  const room = await executor
    .selectFrom('rooms')
    .select(['id', 'name', 'capacity', 'total_units', 'default_min_stay'])
    .where('id', '=', roomId)
    .where('active', '=', true)
    .executeTakeFirst();

  if (!room) return undefined;

  const roomRateRows = await executor
    .selectFrom('room_rates')
    .select(['occupancy', 'weekday_cents', 'weekend_cents'])
    .where('room_id', '=', roomId)
    .execute();

  const overrideRows = await executor
    .selectFrom('rate_overrides')
    .select([
      sql<string>`date::text`.as('date'),
      'units_available',
      'closed',
      'price_cents',
      'min_stay',
    ])
    .where('room_id', '=', roomId)
    .where('date', '>=', parseDateUTC(checkIn))
    .where('date', '<', parseDateUTC(checkOut))
    .execute();

  const reservationRows = await executor
    .selectFrom('reservations')
    .select([
      sql<string>`check_in::text`.as('check_in'),
      sql<string>`check_out::text`.as('check_out'),
      'status',
      'expires_at',
    ])
    .where('room_id', '=', roomId)
    .where('check_in', '<', parseDateUTC(checkOut))
    .where('check_out', '>', parseDateUTC(checkIn))
    .where('status', '!=', 'cancelled')
    .execute();

  const occupiedByDate: Record<string, number> = {};
  const now = new Date();

  for (const reservation of reservationRows) {
    const isActive =
      reservation.status === 'confirmed' ||
      reservation.expires_at == null ||
      new Date(reservation.expires_at) > now;
    if (!isActive) continue;

    const overlapStart = reservation.check_in > checkIn ? reservation.check_in : checkIn;
    const overlapEnd = reservation.check_out < checkOut ? reservation.check_out : checkOut;

    for (const night of eachNightUTC(overlapStart, overlapEnd)) {
      occupiedByDate[night] = (occupiedByDate[night] ?? 0) + 1;
    }
  }

  return {
    roomId: room.id,
    name: room.name,
    capacity: room.capacity,
    totalUnits: room.total_units,
    defaultMinStay: room.default_min_stay,
    roomRates: roomRateRows.map((r) => ({
      occupancy: r.occupancy,
      weekdayCents: r.weekday_cents,
      weekendCents: r.weekend_cents,
    })),
    overrides: overrideRows.map((o) => ({
      date: o.date,
      unitsAvailable: o.units_available,
      closed: o.closed,
      priceCents: o.price_cents,
      minStay: o.min_stay,
    })),
    occupiedByDate,
  };
}
