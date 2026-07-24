/**
 * moveNight / moveStay — SPEC-modulo-7-gestion-operativa.md § 4.
 *
 * § 1's principle governs every check here: physical unit-night integrity
 * (§ 4.2.4) is NEVER skippable, not even with `force_commercial: true`.
 * Commercial rules (§ 4.2.5) are the only thing that flag skips.
 *
 * Lock: SPEC § 4.2.1 says "the same advisory lock as createReservation", but
 * createReservation doesn't actually use an advisory lock — it takes a
 * `FOR UPDATE` row lock on `rooms` (serializing new-reservation writes for a
 * ROOM TYPE). Move operates on an existing reservation, competing for a
 * specific `room_unit_id`/night, not a room-type row — the mechanism that
 * actually matches is the `pg_advisory_xact_lock(reservationId)` pattern
 * already used by `createOrReusePayment`/`registerPayment`'s cash path (see
 * reservationActions.ts). Reused verbatim here (decision confirmed with
 * project owner 2026-07-23).
 *
 * That lock only serializes concurrent moves of the SAME reservation. Two
 * DIFFERENT reservations racing to move into the same free unit-night take
 * different lock keys and never block each other — the only thing standing
 * between them is `reservation_nights`'s `UNIQUE (room_unit_id, night)`
 * constraint (reservation_nights_unit_night_unique). The pre-write SELECT
 * check below is an optimization (fails fast with a clean error before
 * touching the row), not the real guard; the real guard is the constraint,
 * whose violation is caught at INSERT time and translated to the same
 * PhysicalConflictError as the pre-check. Skipping that catch is exactly
 * what the concurrency test in panelMoveReservation.test.ts is designed to
 * catch (falls back to a raw, uncaught 500 instead of 409).
 */
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { isReservationActive } from '../availability/isReservationActive.js';
import { assertReservationNightsConsistency } from '../availability/checkReservationNightsConsistency.js';
import { isUnitNightUniqueViolation } from '../availability/isUnitNightUniqueViolation.js';
import { addDaysUTC, formatDateUTC, parseDateUTC } from '../shared/dateUtils.js';

const MOVABLE_STATUSES = new Set(['pending_payment', 'confirmed', 'checked_in']);

export class ReservationNotFoundError extends Error {
  constructor() {
    super('Reservation not found');
  }
}

export class ReservationNotMovableError extends Error {
  constructor(readonly status: string) {
    super(`Reservation is '${status}', not movable`);
  }
}

export class NightNotInStayError extends Error {
  constructor(readonly night: string) {
    super(`Night ${night} is not part of this reservation's stay`);
  }
}

export class DestinationUnitNotFoundError extends Error {
  constructor() {
    super('Destination unit not found or inactive');
  }
}

/** § 4.2.4 — physical unit-night integrity. Never skippable, no force flag reaches this. */
export class PhysicalConflictError extends Error {
  constructor(readonly nights: string[]) {
    super(`Destination unit is already occupied for night(s): ${nights.join(', ')}`);
  }
}

export interface CommercialWarning {
  code: 'CAPACITY_EXCEEDED' | 'ADULTS_ONLY_ROOM';
  message: string;
}

/** § 4.2.5 — commercial rules. Skippable with force_commercial: true. */
export class CommercialWarningError extends Error {
  constructor(readonly warnings: CommercialWarning[]) {
    super('Destination unit violates commercial rules');
  }
}

interface ReservationRow {
  id: number;
  status: string;
  guests: number;
  children: number;
  babies: number;
  check_in: string;
  check_out: string;
}

async function fetchReservationByCode(db: Kysely<DB>, code: string): Promise<ReservationRow | undefined> {
  return db
    .selectFrom('reservations')
    .select([
      'id',
      'status',
      'guests',
      'children',
      'babies',
      sql<string>`check_in::text`.as('check_in'),
      sql<string>`check_out::text`.as('check_out'),
    ])
    .where('code', '=', code)
    .executeTakeFirst();
}

async function fetchDestinationUnit(db: Kysely<DB>, toUnitId: number) {
  return db
    .selectFrom('room_units')
    .innerJoin('rooms', 'rooms.id', 'room_units.room_id')
    .select(['room_units.id as id', 'rooms.capacity as capacity', 'rooms.adults_only as adults_only'])
    .where('room_units.id', '=', toUnitId)
    .where('room_units.active', '=', true)
    .executeTakeFirst();
}

/**
 * Pre-write check for § 4.2.4. Queries `reservation_nights` for the
 * destination unit over [fromNight, toNightExclusive), excluding the
 * reservation being moved (a night already assigned to itself on that unit
 * isn't a conflict — this is what makes moving a single night back to its
 * own unit a no-op instead of a false-positive rejection). Range-based, not
 * an `IN` list, matching the date-comparison pattern already used in
 * repository.ts's `fetchRoomStayData` (plain 'YYYY-MM-DD' strings cast on
 * the Postgres side via `::date`, never a JS Date param — see that file's
 * comment for why).
 */
async function assertNightsFree(
  db: Kysely<DB>,
  toUnitId: number,
  fromNight: string,
  toNightExclusive: string,
  excludeReservationId: number,
): Promise<void> {
  const rows = await db
    .selectFrom('reservation_nights')
    .innerJoin('reservations', 'reservations.id', 'reservation_nights.reservation_id')
    .select([
      sql<string>`reservation_nights.night::text`.as('night'),
      'reservations.status as status',
      'reservations.expires_at as expires_at',
    ])
    .where('reservation_nights.room_unit_id', '=', toUnitId)
    .where('reservation_nights.night', '>=', sql<Date>`${fromNight}::date`)
    .where('reservation_nights.night', '<', sql<Date>`${toNightExclusive}::date`)
    .where('reservation_nights.reservation_id', '!=', excludeReservationId)
    .execute();

  const occupied = rows.filter((r) => isReservationActive(r.status, r.expires_at)).map((r) => r.night);
  if (occupied.length > 0) throw new PhysicalConflictError(occupied);
}

function commercialWarnings(
  destination: { capacity: number; adults_only: boolean },
  reservation: Pick<ReservationRow, 'guests' | 'children' | 'babies'>,
): CommercialWarning[] {
  const warnings: CommercialWarning[] = [];

  // Mascotas (§ 4.2.5) deliberately omitted: no column on `reservations`
  // records whether the stay involves a pet, so there is nothing to check
  // against `rooms.pets_allowed`. Known model gap, not a 7C oversight —
  // candidate for M8 or whenever the reservation form grows a pet field.
  if (destination.adults_only && (reservation.children > 0 || reservation.babies > 0)) {
    warnings.push({ code: 'ADULTS_ONLY_ROOM', message: 'this room does not allow children or babies' });
  }
  if (reservation.guests > destination.capacity) {
    warnings.push({ code: 'CAPACITY_EXCEEDED', message: `guests exceeds room capacity (${destination.capacity})` });
  }

  return warnings;
}

async function runWriteInsideLock<T>(
  db: Kysely<DB>,
  reservationId: number,
  write: (trx: Kysely<DB>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    // Serializes concurrent move requests for THIS reservation (see module
    // doc comment for what this lock does and doesn't cover).
    await sql`SELECT pg_advisory_xact_lock(${reservationId})`.execute(trx);

    // Re-check status AFTER the lock, not just the unlocked read done before
    // it: nothing in 7C changes status concurrently, but § 8 (7D) adds
    // cancel/no-show, which does. Without this, a cancel landing between the
    // pre-lock read and the lock could let a move write reservation_nights
    // rows for a reservation that's no longer active — the same class of bug
    // checkOut's `FOR UPDATE` + re-read guards against.
    const fresh = await trx
      .selectFrom('reservations')
      .select('status')
      .where('id', '=', reservationId)
      .executeTakeFirstOrThrow();
    if (!MOVABLE_STATUSES.has(fresh.status)) throw new ReservationNotMovableError(fresh.status);

    const result = await write(trx);
    await assertReservationNightsConsistency(trx, reservationId);
    return result;
  });
}

async function insertNightOrThrowConflict(
  trx: Kysely<DB>,
  reservationId: number,
  night: string,
  toUnitId: number,
): Promise<void> {
  try {
    await trx
      .insertInto('reservation_nights')
      .values({ reservation_id: reservationId, night, room_unit_id: toUnitId })
      .execute();
  } catch (err) {
    if (isUnitNightUniqueViolation(err)) throw new PhysicalConflictError([night]);
    throw err;
  }
}

export interface MoveNightInput {
  code: string;
  night: string;
  toUnitId: number;
  forceCommercial?: boolean;
}

export async function moveNight(db: Kysely<DB>, input: MoveNightInput): Promise<void> {
  const reservation = await fetchReservationByCode(db, input.code);
  if (!reservation) throw new ReservationNotFoundError();
  if (!MOVABLE_STATUSES.has(reservation.status)) throw new ReservationNotMovableError(reservation.status);
  if (input.night < reservation.check_in || input.night >= reservation.check_out) {
    throw new NightNotInStayError(input.night);
  }

  const destination = await fetchDestinationUnit(db, input.toUnitId);
  if (!destination) throw new DestinationUnitNotFoundError();

  const nextNight = formatDateUTC(addDaysUTC(parseDateUTC(input.night), 1));
  await assertNightsFree(db, input.toUnitId, input.night, nextNight, reservation.id);

  const warnings = commercialWarnings(destination, reservation);
  if (warnings.length > 0 && !input.forceCommercial) throw new CommercialWarningError(warnings);

  await runWriteInsideLock(db, reservation.id, async (trx) => {
    await trx
      .deleteFrom('reservation_nights')
      .where('reservation_id', '=', reservation.id)
      .where('night', '=', sql<Date>`${input.night}::date`)
      .execute();

    await insertNightOrThrowConflict(trx, reservation.id, input.night, input.toUnitId);
  });
}

export interface MoveStayInput {
  code: string;
  toUnitId: number;
  forceCommercial?: boolean;
}

export async function moveStay(db: Kysely<DB>, input: MoveStayInput): Promise<void> {
  const reservation = await fetchReservationByCode(db, input.code);
  if (!reservation) throw new ReservationNotFoundError();
  if (!MOVABLE_STATUSES.has(reservation.status)) throw new ReservationNotMovableError(reservation.status);

  const destination = await fetchDestinationUnit(db, input.toUnitId);
  if (!destination) throw new DestinationUnitNotFoundError();

  const nightRows = await db
    .selectFrom('reservation_nights')
    .select([sql<string>`night::text`.as('night')])
    .where('reservation_id', '=', reservation.id)
    .orderBy('night')
    .execute();
  const nights = nightRows.map((r) => r.night);

  await assertNightsFree(db, input.toUnitId, reservation.check_in, reservation.check_out, reservation.id);

  const warnings = commercialWarnings(destination, reservation);
  if (warnings.length > 0 && !input.forceCommercial) throw new CommercialWarningError(warnings);

  // Atomic: everything below runs inside the single lock+transaction from
  // runWriteInsideLock, so a conflict on ANY night (caught via the unique
  // constraint on a later insert) rolls back every insert already done in
  // this call — never a half-moved stay.
  await runWriteInsideLock(db, reservation.id, async (trx) => {
    await trx.deleteFrom('reservation_nights').where('reservation_id', '=', reservation.id).execute();

    for (const night of nights) {
      await insertNightOrThrowConflict(trx, reservation.id, night, input.toUnitId);
    }
  });
}
