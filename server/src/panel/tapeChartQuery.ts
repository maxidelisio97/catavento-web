/**
 * Read model for the tape chart, per SPEC-modulo-6-panel-base.md §
 * "6C.1 Endpoints de lectura" / "GET /panel/tape-chart".
 *
 * Returns occupied nights only (not a full grid) — the front arms the grid
 * and treats missing cells as empty.
 */
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { isReservationActive } from '../availability/isReservationActive.js';
import { eachNightUTC, todayISO } from '../shared/dateUtils.js';

const MAX_TAPE_CHART_NIGHTS = 60;

// Reservations in these statuses can never be active (see isReservationActive) —
// filtered at the SQL level purely to shrink the row set before the JS
// isReservationActive check runs (which additionally excludes expired holds).
const NON_TERMINAL_STATUSES = ['confirmed', 'pending_payment'] as const;

export class InvalidTapeChartRangeError extends Error {}

export interface TapeChartUnit {
  id: number;
  label: string;
  room_type: string;
  capacity: number;
  sort_order: number;
}

export interface TapeChartNight {
  night: string;
  room_unit_id: number;
  reservation_id: number;
  code: string | null;
  guest_name: string | null;
  has_balance_due: boolean;
  is_first_night: boolean;
  is_last_night: boolean;
  is_fragmented: boolean;
  fragment_group: number | null;
}

export interface TapeChartSummary {
  arrivals_today: number;
  departures_today: number;
  occupied_today: number;
  total_units: number;
}

export interface TapeChartResult {
  from: string;
  to: string;
  units: TapeChartUnit[];
  nights: TapeChartNight[];
  summary: TapeChartSummary;
}

export async function getTapeChart(db: Kysely<DB>, from: string, to: string): Promise<TapeChartResult> {
  const windowNights = eachNightUTC(from, to);
  if (windowNights.length === 0) {
    throw new InvalidTapeChartRangeError('`to` must be after `from`');
  }
  if (windowNights.length > MAX_TAPE_CHART_NIGHTS) {
    throw new InvalidTapeChartRangeError(`Range cannot exceed ${MAX_TAPE_CHART_NIGHTS} nights`);
  }

  const units = await db
    .selectFrom('room_units')
    .innerJoin('rooms', 'rooms.id', 'room_units.room_id')
    .select([
      'room_units.id as id',
      'room_units.label as label',
      'rooms.name as room_type',
      'rooms.capacity as capacity',
      'rooms.sort_order as sort_order',
    ])
    .where('room_units.active', '=', true)
    .orderBy('rooms.sort_order')
    .orderBy('room_units.label')
    .execute();

  const rawNights = await db
    .selectFrom('reservation_nights')
    .innerJoin('reservations', 'reservations.id', 'reservation_nights.reservation_id')
    .select([
      sql<string>`reservation_nights.night::text`.as('night'),
      'reservation_nights.room_unit_id as room_unit_id',
      'reservations.id as reservation_id',
      'reservations.code as code',
      'reservations.guest_name as guest_name',
      'reservations.total_cents as total_cents',
      'reservations.status as status',
      'reservations.expires_at as expires_at',
      sql<string>`reservations.check_in::text`.as('check_in'),
      sql<string>`reservations.check_out::text`.as('check_out'),
    ])
    .where('reservation_nights.night', '>=', sql<Date>`${from}::date`)
    .where('reservation_nights.night', '<', sql<Date>`${to}::date`)
    .where('reservations.status', 'in', NON_TERMINAL_STATUSES)
    .execute();

  const activeNights = rawNights.filter((row) => isReservationActive(row.status, row.expires_at));

  const nights = activeNights.length > 0 ? await buildTapeChartNights(db, activeNights) : [];
  const summary = await getTapeChartSummary(db, units.length);

  return { from, to, units, nights, summary };
}

interface RawActiveNight {
  night: string;
  room_unit_id: number;
  reservation_id: number;
  code: string | null;
  guest_name: string | null;
  total_cents: number;
  check_in: string;
  check_out: string;
}

async function buildTapeChartNights(db: Kysely<DB>, activeNights: RawActiveNight[]): Promise<TapeChartNight[]> {
  const reservationIds = [...new Set(activeNights.map((row) => row.reservation_id))];

  // Both computed over ALL of the reservation's rows, never just the
  // visible window — SPEC § 6C.1: "is_fragmented ... verdadero cuando la
  // reserva tiene filas con más de un room_unit_id distinto", not "in the
  // visible window has more than one".
  const [fragmentCounts, paidSums] = await Promise.all([
    db
      .selectFrom('reservation_nights')
      .select(['reservation_id', sql<string>`count(distinct room_unit_id)`.as('unit_count')])
      .where('reservation_id', 'in', reservationIds)
      .groupBy('reservation_id')
      .execute(),
    db
      .selectFrom('payments')
      .select(['reservation_id', sql<string>`sum(amount_cents)`.as('paid_cents')])
      .where('reservation_id', 'in', reservationIds)
      .where('status', '=', 'received')
      .groupBy('reservation_id')
      .execute(),
  ]);

  const fragmentedIds = new Set(
    fragmentCounts.filter((row) => Number(row.unit_count) > 1).map((row) => row.reservation_id),
  );
  const paidByReservation = new Map(paidSums.map((row) => [row.reservation_id, Number(row.paid_cents)]));

  return activeNights.map((row) => {
    const paidCents = paidByReservation.get(row.reservation_id) ?? 0;
    const isFragmented = fragmentedIds.has(row.reservation_id);
    const lastNight = eachNightUTC(row.check_in, row.check_out).at(-1) ?? row.check_in;

    return {
      night: row.night,
      room_unit_id: row.room_unit_id,
      reservation_id: row.reservation_id,
      code: row.code,
      guest_name: row.guest_name,
      has_balance_due: row.total_cents - paidCents > 0,
      is_first_night: row.night === row.check_in,
      is_last_night: row.night === lastNight,
      is_fragmented: isFragmented,
      fragment_group: isFragmented ? row.reservation_id : null,
    };
  });
}

/**
 * Always relative to today, regardless of the visible window — SPEC § 6C.1:
 * "El resumen es siempre relativo a hoy, no al rango visible."
 */
async function getTapeChartSummary(db: Kysely<DB>, totalUnits: number): Promise<TapeChartSummary> {
  const today = todayISO();

  const todaysEdges = await db
    .selectFrom('reservations')
    .select([
      'status',
      'expires_at',
      sql<string>`check_in::text`.as('check_in'),
      sql<string>`check_out::text`.as('check_out'),
    ])
    .where((eb) =>
      eb.or([eb('check_in', '=', sql<Date>`${today}::date`), eb('check_out', '=', sql<Date>`${today}::date`)]),
    )
    .where('status', 'in', NON_TERMINAL_STATUSES)
    .execute();

  const activeEdges = todaysEdges.filter((row) => isReservationActive(row.status, row.expires_at));
  const arrivalsToday = activeEdges.filter((row) => row.check_in === today).length;
  const departuresToday = activeEdges.filter((row) => row.check_out === today).length;

  const todaysNights = await db
    .selectFrom('reservation_nights')
    .innerJoin('reservations', 'reservations.id', 'reservation_nights.reservation_id')
    .select([
      'reservation_nights.room_unit_id as room_unit_id',
      'reservations.status as status',
      'reservations.expires_at as expires_at',
    ])
    .where('reservation_nights.night', '=', sql<Date>`${today}::date`)
    .where('reservations.status', 'in', NON_TERMINAL_STATUSES)
    .execute();

  const occupiedToday = new Set(
    todaysNights.filter((row) => isReservationActive(row.status, row.expires_at)).map((row) => row.room_unit_id),
  ).size;

  return { arrivals_today: arrivalsToday, departures_today: departuresToday, occupied_today: occupiedToday, total_units: totalUnits };
}
