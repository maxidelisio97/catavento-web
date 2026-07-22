/**
 * Detects a violation of `reservation_nights_unit_night_unique` (the
 * UNIQUE(room_unit_id, night) anti-overbooking constraint from
 * SPEC-modulo-6-panel-base.md § "6A.1"), as opposed to any other error a
 * `reservation_nights` insert could throw.
 *
 * Mirrors `createReservationWithCode.ts`'s `isCodeUniqueViolation` — same
 * shape, different constraint. Only a genuine violation of THIS constraint
 * means "no room" business-as-usual; anything else (a dropped connection, a
 * bug) must surface as a real error, not get reinterpreted as sold-out.
 */
interface PgUniqueViolation {
  code: string;
  constraint?: string;
}

export function isUnitNightUniqueViolation(err: unknown): err is PgUniqueViolation {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as PgUniqueViolation).code === '23505' &&
    ((err as PgUniqueViolation).constraint?.includes('unit_night') ?? false)
  );
}
