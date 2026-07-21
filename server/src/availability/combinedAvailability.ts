/**
 * Combines the two independent availability checks required by
 * SPEC-modulo-5-unidades-fisicas.md:
 *
 * 1. The existing aggregate per-night check (`calculateAvailability.ts`,
 *    left completely unchanged) — governs the calendar/OTA-phantom-capacity
 *    ceiling (`rate_overrides.units_available`, `closed`).
 * 2. The new per-unit, whole-range freedom check (`findFreeUnits.ts`) —
 *    fixes "fragmentación falsa": the aggregate alone can say a stay is
 *    available even when no single physical unit is free for the whole
 *    range.
 *
 * Neither check alone is sufficient: the aggregate can miss false
 * fragmentation, and `findFreeUnits` alone would ignore the calendar's
 * ceiling (`rate_overrides` can reduce sellable units even when more
 * physical units are free — see spec § "Convivencia con el calendario").
 * The calendar can only ever REDUCE availability, never increase it beyond
 * what's physically free.
 */

import { calculateAvailability, type CalculateAvailabilityInput, type CalculateAvailabilityResult } from './calculateAvailability.js';
import { findFreeUnits, type RoomUnit, type UnitReservation } from './findFreeUnits.js';

export interface CombinedAvailabilityInput extends CalculateAvailabilityInput {
  units: RoomUnit[];
  unitReservations: UnitReservation[];
}

export interface CombinedAvailabilityResult extends CalculateAvailabilityResult {
  /** Units free for the whole range, sorted by label ascending (see findFreeUnits). */
  freeUnits: RoomUnit[];
}

export function calculateCombinedAvailability(input: CombinedAvailabilityInput): CombinedAvailabilityResult {
  const aggregate = calculateAvailability(input);
  const freeUnits = findFreeUnits(input.units, input.unitReservations, input.checkIn, input.checkOut);

  return {
    ...aggregate,
    available: aggregate.available && freeUnits.length >= 1,
    unitsLeft: Math.min(aggregate.unitsLeft, freeUnits.length),
    freeUnits,
  };
}
