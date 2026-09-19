/**
 * Detects a violation of `reservation_nights_reservation_night_unique` (the
 * UNIQUE(reservation_id, night) constraint) — as opposed to
 * `reservation_nights_unit_night_unique` (UNIQUE(room_unit_id, night),
 * handled by `isUnitNightUniqueViolation.ts`) or any other error a
 * `reservation_nights` insert could throw.
 *
 * Documented gap this closes: see server/CLAUDE.md "Deuda conocida" —
 * before this predicate existed, a violation of this constraint propagated
 * as a raw, uncaught 500 because `insertNightOrThrowConflict` in
 * `moveReservation.ts` only recognized the OTHER constraint.
 *
 * NOTE: exact equality, NOT `includes()`. `'reservation_nights_unit_night_unique'
 * .includes('reservation_night')` is TRUE (the table name itself starts with
 * it), so a substring test would silently swallow the OTHER constraint and
 * mislabel a real overbooking conflict as a concurrent-write retry.
 */
interface PgUniqueViolation {
  code: string;
  constraint?: string;
}

const CONSTRAINT = 'reservation_nights_reservation_night_unique';

export function isReservationNightUniqueViolation(err: unknown): err is PgUniqueViolation {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as PgUniqueViolation).code === '23505' &&
    (err as PgUniqueViolation).constraint === CONSTRAINT
  );
}
