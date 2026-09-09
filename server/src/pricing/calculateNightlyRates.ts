/**
 * Per-night, per-occupancy price breakdown for SPEC-modulo-12C § 1.2 (ARI
 * push to Channex). Deliberately NOT a refactor of `calculatePrice.ts`: that
 * function answers "can THIS specific guest count book THIS specific stay"
 * (picks one `room_rates` row via `findRoomRate`'s fallback, rejects on
 * `closed`/`min_stay`). This function answers a different question — "what
 * are the calendar's rates/restrictions for every night, across every
 * configured occupancy" — which Channex's `POST /restrictions` supports
 * directly via its multi-occupancy `rates: [{occupancy, rate}]` array
 * (docs.channex.io/api-v.1-documentation/ari.md), so there's no "which
 * occupancy is the base rate" guess to make here, and no `guests` input.
 *
 * No DB access, same spirit as `calculatePrice.ts`/`calculateAvailability.ts`.
 */

import { eachNightUTC, parseDateUTC } from '../shared/dateUtils.js';

export interface NightlyRoomRateRow {
  occupancy: number;
  weekdayCents: number;
  weekendCents: number;
}

export interface NightlyRateOverrideRow {
  /** Night this override applies to, as 'YYYY-MM-DD'. */
  date: string;
  priceCents: number | null;
  minStay: number | null;
  closed: boolean;
}

export interface CalculateNightlyRatesInput {
  /** Check-in date, 'YYYY-MM-DD'. */
  checkIn: string;
  /** Check-out date, 'YYYY-MM-DD' (exclusive). */
  checkOut: string;
  roomRates: NightlyRoomRateRow[];
  rateOverrides: NightlyRateOverrideRow[];
  roomDefaultMinStay: number;
}

export interface OccupancyRate {
  occupancy: number;
  priceCents: number;
}

export interface NightlyRate {
  date: string;
  closed: boolean;
  minStay: number;
  ratesByOccupancy: OccupancyRate[];
}

/** Weekend = Friday (5) or Saturday (6), same rule as calculatePrice.ts. */
function isWeekendNight(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 5 || day === 6;
}

export function calculateNightlyRates(input: CalculateNightlyRatesInput): NightlyRate[] {
  const { checkIn, checkOut, roomRates, rateOverrides, roomDefaultMinStay } = input;
  const overridesByDate = new Map(rateOverrides.map((o) => [o.date, o]));

  return eachNightUTC(checkIn, checkOut).map((date) => {
    const override = overridesByDate.get(date);
    const weekend = isWeekendNight(parseDateUTC(date));

    const ratesByOccupancy = roomRates.map((rate) => ({
      occupancy: rate.occupancy,
      priceCents: override?.priceCents ?? (weekend ? rate.weekendCents : rate.weekdayCents),
    }));

    return {
      date,
      closed: override?.closed ?? false,
      minStay: override?.minStay ?? roomDefaultMinStay,
      ratesByOccupancy,
    };
  });
}
