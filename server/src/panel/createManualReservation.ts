/**
 * POST /panel/reservations/manual — SPEC-modulo-7-gestion-operativa.md § 7.
 *
 * Reuses `createReservation` (módulo 2's anti-overbooking transaction, never
 * reimplemented) so manual reservations get the SAME lock and the SAME
 * double availability check as the public web flow (§ 7.2's explicit
 * requirement) — this module is a thin wrapper that resolves the room,
 * enforces § 7.2b's hard space rules, classifies the soft ones, and handles
 * the optional payment-at-creation step (§ 7.2).
 *
 * Rule families (§ 1, § 7.2, § 7.2b):
 * - HARD, never skippable: adults_only vs children/babies, pets vs
 *   `rooms.pets_allowed`. Same family as physical unit-night integrity —
 *   rejected before ever touching `createReservation`.
 * - SOFT, skippable with `forceCommercial`: capacity exceeded, min-stay not
 *   met. Capacity is checked here (pure, no DB round trip beyond the room
 *   read already done for the hard checks). Min-stay depends on
 *   `rate_overrides`, which only `createReservation`'s own transaction reads
 *   — rather than duplicating that fetch, `allowBelowMinStay` is threaded
 *   into `createReservation` and a resulting `MinStayNotMetError` is
 *   reinterpreted as a warning here when `forceCommercial` wasn't given.
 *   Known simplification: if capacity is ALSO exceeded and not forced, this
 *   throws on capacity alone without ever reaching the min-stay check — the
 *   operator sees one warning, retries with `forceCommercial: true`, and
 *   that retry passes `allowBelowMinStay: true` from the start, so it never
 *   hits the min-stay branch either. The end result is correct; only the
 *   first response's warning list can be incomplete in that combined case.
 */
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import { NoAvailabilityError, MinStayNotMetError } from '../availability/createReservation.js';
import { createReservationWithCode } from '../reservations/createReservationWithCode.js';
import { getBusinessSettings } from '../settings/settings.js';

export class RoomNotFoundError extends Error {
  constructor() {
    super('Room not found or inactive');
  }
}

/** § 1, § 7.2b — hard rule, never skippable with forceCommercial. */
export class AdultsOnlyRoomError extends Error {
  constructor() {
    super('this room does not allow children or babies');
  }
}

/** § 7.2b — hard rule, never skippable with forceCommercial. */
export class PetsNotAllowedRoomError extends Error {
  constructor() {
    super('this room does not allow pets');
  }
}

export interface ManualCommercialWarning {
  code: 'CAPACITY_EXCEEDED' | 'MIN_STAY_NOT_MET';
  message: string;
}

/** § 7.2 — soft commercial rules. Skippable with forceCommercial: true. */
export class ManualCommercialWarningError extends Error {
  constructor(readonly warnings: ManualCommercialWarning[]) {
    super('Manual reservation violates commercial rules');
  }
}

export { NoAvailabilityError, MinStayNotMetError };

export type ManualPaymentMethod = 'cash' | 'external' | 'pix_manual';
export type ManualPaymentStatus = 'none' | 'deposit_paid' | 'paid_full';

export interface CreateManualReservationInput {
  roomId: number;
  checkIn: string;
  checkOut: string;
  adults: number;
  children?: number;
  childrenAges?: number[];
  babies?: number;
  pets?: boolean;
  guestName: string;
  guestEmail?: string;
  guestPhone?: string;
  notes?: string;
  paymentStatus: ManualPaymentStatus;
  /** Required when paymentStatus is 'deposit_paid' or 'paid_full'. */
  paymentMethod?: ManualPaymentMethod;
  overrideTotalCents?: number;
  forceCommercial?: boolean;
  createdBy: number;
}

export class MissingPaymentMethodError extends Error {
  constructor() {
    super('payment_method is required when payment_status is deposit_paid or paid_full');
  }
}

export interface CreateManualReservationResult {
  id: number;
  code: string | null;
  totalCents: number;
  depositCents: number | null;
  petFeeCents: number;
  paymentId: number | null;
}

export async function createManualReservation(
  db: Kysely<DB>,
  input: CreateManualReservationInput,
): Promise<CreateManualReservationResult> {
  if (
    (input.paymentStatus === 'deposit_paid' || input.paymentStatus === 'paid_full') &&
    !input.paymentMethod
  ) {
    throw new MissingPaymentMethodError();
  }

  const room = await db
    .selectFrom('rooms')
    .select(['id', 'capacity', 'adults_only', 'pets_allowed', 'default_min_stay'])
    .where('id', '=', input.roomId)
    .where('active', '=', true)
    .executeTakeFirst();
  if (!room) throw new RoomNotFoundError();

  const children = input.children ?? 0;
  const babies = input.babies ?? 0;
  const pets = input.pets ?? false;

  // Hard rules first — never reached by forceCommercial (§ 1, § 7.2b).
  if (room.adults_only && (children > 0 || babies > 0)) throw new AdultsOnlyRoomError();
  if (pets && !room.pets_allowed) throw new PetsNotAllowedRoomError();

  const guests = input.adults + children;
  const warnings: ManualCommercialWarning[] = [];
  if (guests > room.capacity) {
    warnings.push({ code: 'CAPACITY_EXCEEDED', message: `guests exceeds room capacity (${room.capacity})` });
  }
  if (warnings.length > 0 && !input.forceCommercial) {
    throw new ManualCommercialWarningError(warnings);
  }

  const { depositPercent, petFeeCents: petFeeCentsPerNight } = await getBusinessSettings(db);

  try {
    const result = await createReservationWithCode(db, {
      roomId: input.roomId,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guests,
      guestName: input.guestName,
      guestEmail: input.guestEmail,
      guestPhone: input.guestPhone,
      notes: input.notes,
      children,
      babies,
      childrenAges: input.childrenAges,
      pets,
      petFeeCentsPerNight,
      // Only a real deposit concept when the operator is actually recording
      // one now — 'none'/'paid_full' don't freeze a partial-deposit figure.
      depositPercent: input.paymentStatus === 'deposit_paid' ? depositPercent : undefined,
      origin: 'manual',
      status: 'confirmed',
      createdBy: input.createdBy,
      allowBelowMinStay: input.forceCommercial ?? false,
      overrideTotalCents: input.overrideTotalCents,
    });

    let paymentId: number | null = null;
    if (input.paymentStatus === 'deposit_paid') {
      const row = await db
        .insertInto('payments')
        .values({
          reservation_id: result.id,
          kind: 'deposit',
          method: input.paymentMethod!,
          amount_cents: result.depositCents ?? 0,
          status: 'received',
          changed_by: input.createdBy,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      paymentId = row.id;
    } else if (input.paymentStatus === 'paid_full') {
      // § 7.2: a single record covering the total, kind='balance', so
      // balance_due lands at 0 — not a deposit+balance pair.
      const row = await db
        .insertInto('payments')
        .values({
          reservation_id: result.id,
          kind: 'balance',
          method: input.paymentMethod!,
          amount_cents: result.totalCents,
          status: 'received',
          changed_by: input.createdBy,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      paymentId = row.id;
    }

    return {
      id: result.id,
      code: result.code,
      totalCents: result.totalCents,
      depositCents: result.depositCents,
      petFeeCents: result.petFeeCents,
      paymentId,
    };
  } catch (err) {
    // § 7.2: min-stay is soft for manual creation, unlike the public web
    // flow — reinterpret the hard error calculatePrice/createReservation
    // throws by default as a warning, same shape as the capacity one above.
    if (err instanceof MinStayNotMetError && !input.forceCommercial) {
      throw new ManualCommercialWarningError([
        ...warnings,
        {
          code: 'MIN_STAY_NOT_MET',
          message: `Stay of ${err.requestedNights} nights is below the ${err.requiredMinStay}-night minimum`,
        },
      ]);
    }
    throw err;
  }
}
