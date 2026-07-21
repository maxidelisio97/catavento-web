/**
 * Per-unit, whole-range freedom check, per
 * SPEC-modulo-5-unidades-fisicas.md § "Regla de asignación".
 *
 * This is the piece that fixes "fragmentación falsa" (spec's test 4): the
 * existing aggregate `calculateAvailability.ts` only counts occupied units
 * per night, so it can report a stay as available even when NO single
 * physical unit is free for the whole requested range (e.g. 2 units A/B, A
 * occupied night 1, B occupied night 3 — per-night counting says 1 free
 * both nights, but no single unit covers a night1-night3 stay).
 * `findFreeUnits` is used ALONGSIDE the aggregate check, never instead of
 * it (see `combinedAvailability.ts`) — it doesn't know about the calendar's
 * `rate_overrides` ceiling, only about which units are physically free.
 *
 * Pure and DB-free: callers fetch `units` and `unitReservations` and pass
 * them in, same spirit as `calculateAvailability.ts`.
 */

export interface RoomUnit {
  id: number;
  label: string;
}

export interface UnitReservation {
  roomUnitId: number;
  /** 'YYYY-MM-DD'. */
  checkIn: string;
  /** 'YYYY-MM-DD', exclusive. */
  checkOut: string;
}

/**
 * Returns the units with zero overlapping entries in `unitReservations`
 * over the whole `[checkIn, checkOut)` range, sorted by `label` ascending.
 *
 * Sort rationale: labels within one room type are same-length strings
 * (Casal: '101'-'106', Triplo: '7'-'9', Quádruplo: '10'-'11'), so a plain
 * string comparison already yields correct numeric order for each type —
 * no need for numeric parsing. This is documented here rather than added
 * as code because the invariant ("same-length labels per type") lives in
 * the seed data, not in this function's logic.
 */
export function findFreeUnits(
  units: RoomUnit[],
  unitReservations: UnitReservation[],
  checkIn: string,
  checkOut: string,
): RoomUnit[] {
  const occupiedUnitIds = new Set<number>();
  for (const reservation of unitReservations) {
    const overlaps = checkIn < reservation.checkOut && reservation.checkIn < checkOut;
    if (overlaps) {
      occupiedUnitIds.add(reservation.roomUnitId);
    }
  }

  return units
    .filter((unit) => !occupiedUnitIds.has(unit.id))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}
