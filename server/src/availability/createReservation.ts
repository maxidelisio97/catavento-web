/**
 * Anti-overbooking transaction, per
 * SPEC-modulo-2-disponibilidad.md § "Transacción anti-overbooking".
 *
 * Not exposed over HTTP yet (módulo 3 will consume this). Every write to
 * `reservations` that affects inventory (create, confirm, reactivate) must
 * go through this pattern: lock the room row, recompute availability inside
 * the transaction, then decide.
 */

import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { calculateCombinedAvailability } from './combinedAvailability.js';
import { fetchRoomStayData } from './repository.js';
import { sweepStaleReservationNights } from './sweepStaleReservationNights.js';
import { isUnitNightUniqueViolation } from './isUnitNightUniqueViolation.js';
import { assertReservationNightsConsistency } from './checkReservationNightsConsistency.js';
import { eachNightUTC } from '../shared/dateUtils.js';
import { calculatePrice } from '../pricing/calculatePrice.js';
import { calculateDeposit } from '../pricing/calculateDeposit.js';

export class NoAvailabilityError extends Error {
  readonly code = 'NO_AVAILABILITY' as const;
  constructor(readonly firstConflictingNight: string) {
    super(`No availability starting ${firstConflictingNight}`);
  }
}

export class MinStayNotMetError extends Error {
  readonly code = 'MIN_STAY_NOT_MET' as const;
  constructor(
    readonly requiredMinStay: number,
    readonly requestedNights: number,
  ) {
    super(`Stay of ${requestedNights} nights is below the ${requiredMinStay}-night minimum`);
  }
}

export interface CreateReservationInput {
  roomId: number;
  checkIn: string;
  checkOut: string;
  /** Total headcount that counts toward capacity (adults + children). */
  guests: number;
  guestName?: string;
  guestEmail?: string;
  guestPhone?: string;
  notes?: string;
  expiresAt?: Date;
  /** Public reference code (módulo 3). Undefined for callers that don't use one. */
  code?: string;
  /**
   * Whole percentage (módulo 4) used to freeze `deposit_cents` at creation
   * time. Undefined for callers that don't track deposits (e.g. módulo 2
   * tests) — deposit_cents stays null in that case.
   */
  depositPercent?: number;
  /** Counts toward capacity together with adults. Defaults to 0. */
  children?: number;
  /** Never counts toward capacity — informational only. Defaults to 0. */
  babies?: number;
  /** One integer per child, range [3, 17]. Defaults to []. */
  childrenAges?: number[];
}

export interface CreateReservationResult {
  id: number;
  totalCents: number;
  code: string | null;
  depositCents: number | null;
}

export async function createReservation(
  db: Kysely<DB>,
  input: CreateReservationInput,
): Promise<CreateReservationResult> {
  return db.transaction().execute(async (trx) => {
    const room = await trx
      .selectFrom('rooms')
      .select('id')
      .where('id', '=', input.roomId)
      .where('active', '=', true)
      .forUpdate()
      .executeTakeFirst();

    if (!room) {
      throw new NoAvailabilityError(input.checkIn);
    }

    // Lazy sweep of stale reservation_nights (módulo 6A — see
    // sweepStaleReservationNights.ts docstring for the full race-safety
    // argument): safe here specifically because it runs AFTER the room-row
    // FOR UPDATE lock above, which already serializes every
    // createReservation call for this roomId — no concurrent transaction
    // for the same room can interleave with this sweep + availability check
    // + insert sequence.
    await sweepStaleReservationNights(trx, input.roomId, input.checkIn, input.checkOut);

    const stayData = await fetchRoomStayData(trx, input.roomId, input.checkIn, input.checkOut);
    if (!stayData) {
      throw new NoAvailabilityError(input.checkIn);
    }

    const availability = calculateCombinedAvailability({
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      totalUnits: stayData.totalUnits,
      overrides: stayData.overrides,
      occupiedByDate: stayData.occupiedByDate,
      units: stayData.roomUnits,
      unitReservations: stayData.unitReservations,
    });

    if (!availability.available) {
      const firstFullNight = availability.nights.find((n) => n.disponibles < 1);
      throw new NoAvailabilityError(firstFullNight ? firstFullNight.date : input.checkIn);
    }

    // availability.available guarantees freeUnits.length >= 1 (see
    // combinedAvailability.ts), but TS can't infer that from the type — the
    // guard below is defensive, not a real "no room" path.
    const chosenUnit = availability.freeUnits[0];
    if (!chosenUnit) {
      throw new NoAvailabilityError(input.checkIn);
    }

    const price = calculatePrice({
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guests: input.guests,
      roomRates: stayData.roomRates,
      rateOverrides: stayData.overrides.map((o) => ({
        date: o.date,
        priceCents: o.priceCents,
        minStay: o.minStay,
        closed: o.closed,
      })),
      roomDefaultMinStay: stayData.defaultMinStay,
    });

    if (price.status === 'unavailable_closed') {
      throw new NoAvailabilityError(price.closedDate);
    }
    if (price.status === 'unavailable_min_stay') {
      throw new MinStayNotMetError(price.requiredMinStay, price.requestedNights);
    }

    const depositCents =
      input.depositPercent !== undefined ? calculateDeposit(price.totalCents, input.depositPercent) : null;

    const reservation = await trx
      .insertInto('reservations')
      .values({
        room_id: input.roomId,
        // Legacy/derived column (módulo 6A) — kept in sync with the first
        // night's unit. All new reads use reservation_nights below.
        room_unit_id: chosenUnit.id,
        check_in: input.checkIn,
        check_out: input.checkOut,
        guests: input.guests,
        status: 'pending_payment',
        expires_at: input.expiresAt ?? null,
        total_cents: price.totalCents,
        deposit_cents: depositCents,
        guest_name: input.guestName ?? null,
        guest_email: input.guestEmail ?? null,
        guest_phone: input.guestPhone ?? null,
        notes: input.notes ?? null,
        code: input.code ?? null,
        children: input.children ?? 0,
        babies: input.babies ?? 0,
        children_ages: input.childrenAges ?? [],
        // Explicit, not relying on the column default: every current
        // creation path IS the public web flow (módulo 6A § "6A.4").
        origin: 'web',
      })
      .returning(['id', 'code'])
      .executeTakeFirstOrThrow();

    // One reservation_nights row per night, all with the chosen unit — 6A
    // still assigns a single unit to the whole stay at automatic creation
    // time; only the operator (M7) fragments. If the UNIQUE
    // (room_unit_id, night) constraint is somehow violated here (a race the
    // FOR UPDATE lock + sweep above should already prevent), it surfaces as
    // a generic insert failure — callers of createReservation see it as an
    // unhandled rejection, same as any other unexpected DB error. Genuine
    // "no room" races are caught earlier by the availability check itself.
    try {
      await trx
        .insertInto('reservation_nights')
        .values(
          eachNightUTC(input.checkIn, input.checkOut).map((night) => ({
            reservation_id: reservation.id,
            night,
            room_unit_id: chosenUnit.id,
          })),
        )
        .execute();
    } catch (err) {
      // Only a genuine violation of the UNIQUE (room_unit_id, night)
      // constraint is a "no room" outcome — the last-line safety net
      // described in SPEC-modulo-6-panel-base.md § 6A.2. Anything else
      // (a dropped connection, an unrelated bug) is a real error and must
      // surface as one, not get reinterpreted as sold-out.
      if (!isUnitNightUniqueViolation(err)) throw err;
      throw new NoAvailabilityError(input.checkIn);
    }

    // Application-layer half of the § 6A.3 invariant: fail loudly, inside
    // this same transaction, if this reservation somehow ended up active
    // with a reservation_nights row count that doesn't match its nights —
    // never let a crippled reservation commit silently.
    await assertReservationNightsConsistency(trx, reservation.id);

    return { id: reservation.id, totalCents: price.totalCents, code: reservation.code, depositCents };
  });
}
