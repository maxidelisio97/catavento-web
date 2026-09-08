/**
 * Pure availability calculation for a stay, per
 * SPEC-modulo-2-disponibilidad.md § "Regla de disponibilidad".
 *
 * No DB access: callers fetch total_units, the relevant `rate_overrides`
 * rows, and the count of active reservations per night, and pass them in.
 */

import { eachNightUTC } from '../shared/dateUtils.js';

export interface AvailabilityOverrideRow {
  /** Night this override applies to, as 'YYYY-MM-DD'. */
  date: string;
  /** Null/undefined = use rooms.total_units for this night. */
  unitsAvailable: number | null;
  closed: boolean;
}

export interface CalculateAvailabilityInput {
  /** Check-in date, 'YYYY-MM-DD'. */
  checkIn: string;
  /** Check-out date, 'YYYY-MM-DD' (exclusive — the stay is [checkIn, checkOut)). */
  checkOut: string;
  totalUnits: number;
  overrides: AvailabilityOverrideRow[];
  /** Count of active reservations per night ('YYYY-MM-DD' -> count). Missing = 0. */
  occupiedByDate: Record<string, number>;
  /**
   * SPEC-modulo-12B-reservas-entrantes.md § 0.2: an OTA already sold this
   * stay — a local `closed` stop-sell can't apply retroactively. Only
   * `createReservation` sets this, and only for `origin === 'ota'`; every
   * other caller (public availability, tape chart, confirmPendingReservation's
   * re-check) keeps `closed` zeroing `cupo` as it always has.
   */
  skipClosedCheck?: boolean;
}

export interface NightAvailability {
  date: string;
  cupo: number;
  ocupadas: number;
  disponibles: number;
}

export interface CalculateAvailabilityResult {
  nights: NightAvailability[];
  /** True when every night in the range has disponibles >= 1. */
  available: boolean;
  /** Minimum disponibles across the range — the units that can be booked as a block. */
  unitsLeft: number;
}

export function calculateAvailability(input: CalculateAvailabilityInput): CalculateAvailabilityResult {
  const { checkIn, checkOut, totalUnits, overrides, occupiedByDate, skipClosedCheck } = input;

  const overridesByDate = new Map(overrides.map((o) => [o.date, o]));

  const nights: NightAvailability[] = eachNightUTC(checkIn, checkOut).map((date) => {
    const override = overridesByDate.get(date);
    const cupo = override?.closed && !skipClosedCheck ? 0 : (override?.unitsAvailable ?? totalUnits);
    const ocupadas = occupiedByDate[date] ?? 0;
    const disponibles = Math.max(cupo - ocupadas, 0);
    return { date, cupo, ocupadas, disponibles };
  });

  const available = nights.every((n) => n.disponibles >= 1);
  const unitsLeft = nights.length === 0 ? 0 : Math.min(...nights.map((n) => n.disponibles));

  return { nights, available, unitsLeft };
}
