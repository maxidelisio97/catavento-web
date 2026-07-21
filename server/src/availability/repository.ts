import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../db/types.js';
import { eachNightUTC } from '../shared/dateUtils.js';

export interface RoomStayData {
  roomId: number;
  name: string;
  capacity: number;
  /**
   * Derived from the count of active `room_units` for this room — módulo 5
   * (SPEC-modulo-5-unidades-fisicas.md). `rooms.total_units` is no longer
   * read here; it stays in the table for backward compatibility only.
   */
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
  /** Active physical units for this room type — módulo 5. */
  roomUnits: { id: number; label: string }[];
  /**
   * Active reservations (same "active" definition as `occupiedByDate`)
   * that have an assigned unit and overlap [checkIn, checkOut) — módulo 5.
   * Unlike `occupiedByDate`, ranges here are NOT clipped to the query
   * window: `findFreeUnits` needs the reservation's real bounds to decide
   * overlap for the whole requested stay.
   */
  unitReservations: { roomUnitId: number; checkIn: string; checkOut: string }[];
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
  /** Excludes this reservation's own occupancy — used to re-check availability for itself. */
  excludeReservationId?: number,
): Promise<RoomStayData | undefined> {
  const room = await executor
    .selectFrom('rooms')
    .select(['id', 'name', 'capacity', 'default_min_stay'])
    .where('id', '=', roomId)
    .where('active', '=', true)
    .executeTakeFirst();

  if (!room) return undefined;

  const roomUnitRows = await executor
    .selectFrom('room_units')
    .select(['id', 'label'])
    .where('room_id', '=', roomId)
    .where('active', '=', true)
    .execute();

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
    // Plain 'YYYY-MM-DD' strings cast in SQL, never a JS Date object: pg
    // serializes a Date param for a DATE column using the CALLING PROCESS's
    // local timezone (not UTC), which silently shifts the boundary by a day
    // whenever that process isn't running in UTC — a real bug this repo's
    // own dev/test environment (America/Buenos_Aires) surfaced. The `::date`
    // cast happens on the Postgres side of a parameterized string, so there's
    // no JS Date and no timezone to get wrong at runtime.
    // The `sql<Date>` type param below is a lie to satisfy Kysely's column-type
    // checker (these columns are typed `Date` in db/types.ts, so `.where()`
    // requires an expression typed as such) — it does NOT mean a JS Date is
    // sent over the wire. Don't "fix" this by passing an actual `Date` value,
    // that's the exact bug this comment is about.
    .where('date', '>=', sql<Date>`${checkIn}::date`)
    .where('date', '<', sql<Date>`${checkOut}::date`)
    .execute();

  let reservationQuery = executor
    .selectFrom('reservations')
    .select([
      sql<string>`check_in::text`.as('check_in'),
      sql<string>`check_out::text`.as('check_out'),
      'status',
      'expires_at',
      'room_unit_id',
    ])
    .where('room_id', '=', roomId)
    .where('check_in', '<', sql<Date>`${checkOut}::date`)
    .where('check_out', '>', sql<Date>`${checkIn}::date`)
    .where('status', '!=', 'cancelled');

  if (excludeReservationId !== undefined) {
    reservationQuery = reservationQuery.where('id', '!=', excludeReservationId);
  }

  const reservationRows = await reservationQuery.execute();

  const occupiedByDate: Record<string, number> = {};
  const unitReservations: { roomUnitId: number; checkIn: string; checkOut: string }[] = [];
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

    if (reservation.room_unit_id != null) {
      unitReservations.push({
        roomUnitId: reservation.room_unit_id,
        checkIn: reservation.check_in,
        checkOut: reservation.check_out,
      });
    }
  }

  return {
    roomId: room.id,
    name: room.name,
    capacity: room.capacity,
    totalUnits: roomUnitRows.length,
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
    roomUnits: roomUnitRows.map((u) => ({ id: u.id, label: u.label })),
    unitReservations,
  };
}
