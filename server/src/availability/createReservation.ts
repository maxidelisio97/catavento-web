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
import { calculateAvailability } from './calculateAvailability.js';
import { fetchRoomStayData } from './repository.js';
import { calculatePrice } from '../pricing/calculatePrice.js';

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
  guests: number;
  guestName?: string;
  guestEmail?: string;
  guestPhone?: string;
  notes?: string;
  expiresAt?: Date;
}

export interface CreateReservationResult {
  id: number;
  totalCents: number;
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

    const stayData = await fetchRoomStayData(trx, input.roomId, input.checkIn, input.checkOut);
    if (!stayData) {
      throw new NoAvailabilityError(input.checkIn);
    }

    const availability = calculateAvailability({
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      totalUnits: stayData.totalUnits,
      overrides: stayData.overrides,
      occupiedByDate: stayData.occupiedByDate,
    });

    if (!availability.available) {
      const firstFullNight = availability.nights.find((n) => n.disponibles < 1);
      throw new NoAvailabilityError(firstFullNight ? firstFullNight.date : input.checkIn);
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

    const reservation = await trx
      .insertInto('reservations')
      .values({
        room_id: input.roomId,
        check_in: input.checkIn,
        check_out: input.checkOut,
        guests: input.guests,
        status: 'pending_payment',
        expires_at: input.expiresAt ?? null,
        total_cents: price.totalCents,
        guest_name: input.guestName ?? null,
        guest_email: input.guestEmail ?? null,
        guest_phone: input.guestPhone ?? null,
        notes: input.notes ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return { id: reservation.id, totalCents: price.totalCents };
  });
}
