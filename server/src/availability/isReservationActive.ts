/**
 * Single source of truth for "does this reservation currently occupy
 * inventory", per SPEC-modulo-6-panel-base.md § "6A.1 Cambio de modelo".
 *
 * Extracted out of repository.ts's `fetchRoomStayData` (where this exact
 * condition lived inline before módulo 6A, but ALWAYS after a
 * `.where('status', '!=', 'cancelled')` filter at the query level — see
 * below) so every place that needs to decide "is this reservation still
 * active" — the aggregate occupancy read in repository.ts, the per-night
 * reservation_nights read in repository.ts, the stale-row sweep in
 * sweepStaleReservationNights.ts, and the invariant check in
 * checkReservationNightsConsistency.ts — calls the SAME function rather
 * than a hand-copied condition that could drift.
 *
 * A reservation is active when it's confirmed, or it's pending_payment and
 * hasn't expired yet (no expires_at, or expires_at still in the future).
 * `cancelled`, `no_show` and `payment_conflict` are NEVER active, regardless
 * of `expiresAt` — this is stated explicitly (rather than left as "anything
 * that isn't confirmed and isn't expired") because the pre-6A inline
 * version of this condition only ever ran on rows already filtered to
 * `status != 'cancelled'` by its caller's query, so it never had to handle
 * a cancelled/payment_conflict row directly. Making this function a real
 * standalone source of truth means it must handle every status itself.
 *
 * SPEC-modulo-7-gestion-operativa.md § 3, § 6.2: `checked_in` and
 * `checked_out` are ALSO active — a checked-in guest still occupies the
 * unit, and a checked-out stay's `reservation_nights` rows stay as
 * historical record and must never be swept (§ 6.2: "la unidad-noche no se
 * libera"). Treating them as inactive would let the lazy sweep
 * (sweepStaleReservationNights.ts) delete rows for a stay that already
 * happened, and would make checkReservationNightsConsistency.ts silently
 * skip validating them.
 */
export function isReservationActive(status: string, expiresAt: Date | string | null): boolean {
  if (status === 'confirmed' || status === 'checked_in' || status === 'checked_out') return true;
  if (status === 'pending_payment') return expiresAt == null || new Date(expiresAt) > new Date();
  return false;
}
