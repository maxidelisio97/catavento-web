import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../db/types.js';
import { eachNightUTC, addDaysUTC, parseDateUTC, formatDateUTC } from '../shared/dateUtils.js';
import { isReservationActive } from './isReservationActive.js';

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
   * One 1-night range per occupied night, sourced from `reservation_nights`
   * (módulo 6A — SPEC-modulo-6-panel-base.md § "6A.1"), for nights that
   * overlap [checkIn, checkOut). Deliberately built as 1-night ranges
   * (`{ roomUnitId, checkIn: night, checkOut: nextNight }`) rather than the
   * reservation's whole-stay range: `findFreeUnits.ts`/`combinedAvailability.ts`
   * already operate on arbitrary ranges, so a single night is just a
   * 1-night range — this means those two files need ZERO changes even
   * though the underlying data source moved from `reservations.room_unit_id`
   * to the per-night table.
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

  for (const reservation of reservationRows) {
    if (!isReservationActive(reservation.status, reservation.expires_at)) continue;

    const overlapStart = reservation.check_in > checkIn ? reservation.check_in : checkIn;
    const overlapEnd = reservation.check_out < checkOut ? reservation.check_out : checkOut;

    for (const night of eachNightUTC(overlapStart, overlapEnd)) {
      occupiedByDate[night] = (occupiedByDate[night] ?? 0) + 1;
    }
  }

  // Per-unit occupancy — módulo 6A: sourced from `reservation_nights`, not
  // `reservations.room_unit_id` (see `unitReservations` doc comment above).
  // Joins to `reservations` only to read status/expires_at for
  // `isReservationActive`; `excludeReservationId` (re-check of a
  // reservation's own occupancy) is honored the same way as the aggregate
  // query above.
  const unitReservations: { roomUnitId: number; checkIn: string; checkOut: string }[] = [];

  if (roomUnitRows.length > 0) {
    let nightsQuery = executor
      .selectFrom('reservation_nights')
      .innerJoin('reservations', 'reservations.id', 'reservation_nights.reservation_id')
      .select([
        'reservation_nights.room_unit_id as room_unit_id',
        sql<string>`reservation_nights.night::text`.as('night'),
        'reservations.status as status',
        'reservations.expires_at as expires_at',
      ])
      .where(
        'reservation_nights.room_unit_id',
        'in',
        roomUnitRows.map((u) => u.id),
      )
      .where('reservation_nights.night', '>=', sql<Date>`${checkIn}::date`)
      .where('reservation_nights.night', '<', sql<Date>`${checkOut}::date`)
      .where('reservations.status', '!=', 'cancelled');

    if (excludeReservationId !== undefined) {
      nightsQuery = nightsQuery.where('reservation_nights.reservation_id', '!=', excludeReservationId);
    }

    const nightRows = await nightsQuery.execute();

    for (const row of nightRows) {
      if (!isReservationActive(row.status, row.expires_at)) continue;
      const nextNight = formatDateUTC(addDaysUTC(parseDateUTC(row.night), 1));
      unitReservations.push({ roomUnitId: row.room_unit_id, checkIn: row.night, checkOut: nextNight });
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
