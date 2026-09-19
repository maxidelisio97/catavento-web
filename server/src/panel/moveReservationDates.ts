/**
 * POST /panel/reservations/:code/move-dates — sdd/move-reservation-dates.
 *
 * Sibling of `moveReservation.ts` (moveNight/moveStay), NOT an extension of
 * it, and `processBookingRevision.ts` stays untouched. Borrows
 * `reassignOtaReservation`'s dual lock (advisory lock on the reservation,
 * THEN `FOR UPDATE` on the `rooms` row — same order everywhere in this
 * codebase, so there's no lock-order inversion) and its
 * sweep -> fetchRoomStayData -> release -> bulk insert -> UPDATE reservations
 * -> assertReservationNightsConsistency sequence, but keeps `moveStay`'s
 * atomic all-or-nothing conflict policy: any conflict throws, never
 * degrades to a partial/`ota_conflict` state.
 *
 * Unlike moveNight/moveStay, this endpoint moves DATES, not the physical
 * unit: the reservation's existing room_unit_id (the unit assigned to its
 * current check-in night) is reused, and `assertNightsFree` verifies THAT
 * unit is free for the new range.
 *
 * Dates cross every boundary as bare 'YYYY-MM-DD' strings; no `Date` object
 * is ever serialized (see repository.ts's overrideRows query for why).
 */
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { assertReservationNightsConsistency } from '../availability/checkReservationNightsConsistency.js';
import { isUnitNightUniqueViolation } from '../availability/isUnitNightUniqueViolation.js';
import { isReservationNightUniqueViolation } from '../availability/isReservationNightUniqueViolation.js';
import { sweepStaleReservationNights } from '../availability/sweepStaleReservationNights.js';
import { releaseReservationNights } from '../availability/releaseReservationNights.js';
import { fetchRoomStayData } from '../availability/repository.js';
import { calculatePrice, type CalculatePriceInput } from '../pricing/calculatePrice.js';
import { eachNightUTC } from '../shared/dateUtils.js';
import {
  fetchReservationByCode,
  assertNightsFree,
  PhysicalConflictError,
  ReservationNotFoundError,
  ReservationNotMovableError,
} from './moveReservation.js';

/**
 * pending_payment/confirmed only. `checked_in` is excluded ENTIRELY (not
 * "check_out only"): the overlap rule below always rejects a request that
 * keeps check_in fixed (any check_out-only change necessarily overlaps the
 * current range when check_in is unchanged), so a check_out-only carve-out
 * for checked_in would be unreachable dead code. A checked_in guest's date
 * change is really "extend/shorten stay", which is an explicit non-goal of
 * this feature (future "Estender estadia") — decided by the project owner
 * after this exact contradiction was found during PR 1's implementation.
 */
const MOVABLE_DATE_STATUSES = new Set(['pending_payment', 'confirmed']);

export class DateRangeOverlapError extends Error {
  constructor() {
    super("Requested range overlaps the reservation's current range");
  }
}

/**
 * Defense-in-depth: with the shared advisory-lock key, this is unreachable
 * through this endpoint alone (the lock fully serializes concurrent moves
 * of the SAME reservation) — it guards against a future caller writing
 * `reservation_nights` for this reservation under a different lock key, or
 * none at all. See `isReservationNightUniqueViolation.ts`'s doc comment.
 */
export class ConcurrentNightWriteError extends Error {
  constructor() {
    super('Reservation nights were modified concurrently');
  }
}

export interface MoveDateWarning {
  code: 'BELOW_MIN_STAY';
  message: string;
}

export interface MoveReservationDatesInput {
  code: string;
  checkIn: string;
  checkOut: string;
  recalculatePrice: boolean;
}

export interface MoveReservationDatesResult {
  warnings: MoveDateWarning[];
}

function assertMovableStatus(status: string): void {
  if (MOVABLE_DATE_STATUSES.has(status)) return;
  throw new ReservationNotMovableError(status);
}

export async function moveReservationDates(
  db: Kysely<DB>,
  input: MoveReservationDatesInput,
): Promise<MoveReservationDatesResult> {
  const reservation = await fetchReservationByCode(db, input.code);
  if (!reservation) throw new ReservationNotFoundError();

  // Status gate is on `reservations.status` alone, never a date-vs-today
  // comparison (spec: "Status-Based Field Gating") — a past-dated
  // `confirmed` reservation keeps full-range edit rights.
  assertMovableStatus(reservation.status);

  // Overlap rule, against the CURRENT range: reject before touching anything.
  if (input.checkIn < reservation.check_out && input.checkOut > reservation.check_in) {
    throw new DateRangeOverlapError();
  }

  const warnings: MoveDateWarning[] = [];

  await db.transaction().execute(async (trx) => {
    // Serializes concurrent move-dates requests for THIS reservation. Order
    // (advisory lock -> rooms FOR UPDATE) matches `reassignOtaReservation`,
    // so there's no lock-order inversion anywhere in the codebase.
    await sql`SELECT pg_advisory_xact_lock(${reservation.id})`.execute(trx);
    await trx.selectFrom('rooms').select('id').where('id', '=', reservation.room_id).forUpdate().executeTakeFirstOrThrow();

    // Re-check AFTER the lock, not just the unlocked read done before it —
    // same rationale as moveReservation.ts's runWriteInsideLock.
    const fresh = await trx
      .selectFrom('reservations')
      .select(['status', sql<string>`check_in::text`.as('check_in')])
      .where('id', '=', reservation.id)
      .executeTakeFirstOrThrow();
    assertMovableStatus(fresh.status);

    // Reuse the reservation's existing physical unit (unit assigned to its
    // current check-in night) — a date move never reassigns the unit.
    const unitRow = await trx
      .selectFrom('reservation_nights')
      .select('room_unit_id')
      .where('reservation_id', '=', reservation.id)
      .where('night', '=', sql<Date>`${fresh.check_in}::date`)
      .executeTakeFirst();
    if (!unitRow) {
      throw new Error(`unreachable: active reservation ${reservation.id} has no reservation_nights row for its check-in night`);
    }
    const unitId = unitRow.room_unit_id;

    await sweepStaleReservationNights(trx, reservation.room_id, input.checkIn, input.checkOut);

    const stayData = await fetchRoomStayData(trx, reservation.room_id, input.checkIn, input.checkOut, reservation.id);
    if (!stayData) throw new ReservationNotFoundError();

    await assertNightsFree(trx, unitId, input.checkIn, input.checkOut, reservation.id);

    // Min-stay is a non-blocking warning here (spec: "Non-Blocking Min-Stay
    // Warning"), regardless of `recalculatePrice` — always computed.
    // `skipClosedCheck: true`: this isn't a new sale against a closed
    // night, it's an existing reservation shifting dates (same rationale
    // OTA reconciliation uses `skipClosedCheck` for an already-sold stay).
    const basePriceInput: CalculatePriceInput = {
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guests: reservation.guests,
      roomRates: stayData.roomRates,
      rateOverrides: stayData.overrides,
      roomDefaultMinStay: stayData.defaultMinStay,
      skipClosedCheck: true,
    };

    const priceResult = calculatePrice({ ...basePriceInput, allowBelowMinStay: false });
    let totalCentsForRecalc: number;
    if (priceResult.status === 'unavailable_min_stay') {
      warnings.push({
        code: 'BELOW_MIN_STAY',
        message: `A nova estadia tem ${priceResult.requestedNights} noite(s), abaixo do mínimo de ${priceResult.requiredMinStay} noite(s) — o movimento não foi bloqueado.`,
      });
      const allowed = calculatePrice({ ...basePriceInput, allowBelowMinStay: true });
      totalCentsForRecalc = allowed.status === 'available' ? allowed.totalCents : 0;
    } else if (priceResult.status === 'available') {
      totalCentsForRecalc = priceResult.totalCents;
    } else {
      // Unreachable: skipClosedCheck: true disables this branch.
      totalCentsForRecalc = 0;
    }

    await releaseReservationNights(trx, reservation.id);

    try {
      await trx
        .insertInto('reservation_nights')
        .values(
          eachNightUTC(input.checkIn, input.checkOut).map((night) => ({
            reservation_id: reservation.id,
            night,
            room_unit_id: unitId,
          })),
        )
        .execute();
    } catch (err) {
      if (isUnitNightUniqueViolation(err)) throw new PhysicalConflictError(eachNightUTC(input.checkIn, input.checkOut));
      if (isReservationNightUniqueViolation(err)) throw new ConcurrentNightWriteError();
      throw err;
    }

    await trx
      .updateTable('reservations')
      .set({
        check_in: input.checkIn,
        check_out: input.checkOut,
        ...(input.recalculatePrice ? { total_cents: totalCentsForRecalc } : {}),
      })
      .where('id', '=', reservation.id)
      .execute();

    await assertReservationNightsConsistency(trx, reservation.id);
  });

  return { warnings };
}
