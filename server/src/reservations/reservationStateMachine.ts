/**
 * Reservation status state machine, per
 * SPEC-modulo-7-gestion-operativa.md § 3.
 *
 * Pure logic only — not wired to any endpoint yet (that's 7B/7C/7D). Every
 * panel write that changes `reservations.status` must go through
 * `assertValidTransition` rather than hand-rolling its own status check, so
 * the transition table in the spec stays the single source of truth.
 *
 * `payment_conflict` is inherited from M4 and untouched by M7 (§ 0): it has
 * no outgoing transitions here, matching the spec's diagram.
 *
 * `ota_conflict` (SPEC-modulo-12B-reservas-entrantes.md § 0.1) is the same
 * family as `payment_conflict` — a reservation with no `reservation_nights`
 * assigned, excluded from disponibilidad — but unlike `payment_conflict` it
 * DOES have outgoing transitions: manual retry can resolve it into
 * `confirmed` once a unit frees up, and the OTA can cancel the underlying
 * booking while it's still unresolved.
 */

export type ReservationStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'cancelled'
  | 'payment_conflict'
  | 'checked_in'
  | 'checked_out'
  | 'no_show'
  | 'ota_conflict';

const VALID_TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  pending_payment: ['confirmed', 'cancelled'],
  confirmed: ['checked_in', 'cancelled', 'no_show', 'ota_conflict'],
  checked_in: ['checked_out'],
  cancelled: [],
  checked_out: [],
  no_show: [],
  payment_conflict: [],
  ota_conflict: ['confirmed', 'cancelled'],
};

export class InvalidReservationTransitionError extends Error {
  readonly code = 'INVALID_RESERVATION_TRANSITION' as const;
  constructor(
    readonly from: ReservationStatus,
    readonly to: ReservationStatus,
  ) {
    super(`Cannot transition reservation from '${from}' to '${to}'`);
  }
}

export function isValidTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/** Throws {@link InvalidReservationTransitionError} (map to HTTP 409) if the transition isn't allowed. */
export function assertValidTransition(from: ReservationStatus, to: ReservationStatus): void {
  if (!isValidTransition(from, to)) {
    throw new InvalidReservationTransitionError(from, to);
  }
}
