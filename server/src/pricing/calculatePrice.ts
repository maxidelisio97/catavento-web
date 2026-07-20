/**
 * Pure pricing calculation for a stay, per
 * SPEC-modulo-1-cuartos-y-tarifas.md § "Regla de cálculo de precio".
 *
 * No DB access: callers fetch the relevant `room_rates` and
 * `rate_overrides` rows and pass them in as plain data.
 */

export interface RoomRateRow {
  occupancy: number;
  weekdayCents: number;
  weekendCents: number;
}

export interface RateOverrideRow {
  /** Night this override applies to, as 'YYYY-MM-DD'. */
  date: string;
  /** Null/undefined = no price override for this night (use base rate). */
  priceCents: number | null;
  /** Null/undefined = no min-stay override for this night. */
  minStay: number | null;
  closed: boolean;
}

export interface CalculatePriceInput {
  /** Check-in date, 'YYYY-MM-DD'. */
  checkIn: string;
  /** Check-out date, 'YYYY-MM-DD' (exclusive — the stay is [checkIn, checkOut)). */
  checkOut: string;
  /** Requested guest count. */
  guests: number;
  roomRates: RoomRateRow[];
  rateOverrides: RateOverrideRow[];
  /** Fallback when there's no override for the check-in date. */
  roomDefaultMinStay: number;
}

export interface PriceAvailable {
  status: 'available';
  totalCents: number;
  nights: number;
}

export interface PriceUnavailableClosed {
  status: 'unavailable_closed';
  /** First closed night found within the range. */
  closedDate: string;
}

export interface PriceUnavailableMinStay {
  status: 'unavailable_min_stay';
  requiredMinStay: number;
  requestedNights: number;
}

export type CalculatePriceResult = PriceAvailable | PriceUnavailableClosed | PriceUnavailableMinStay;

/** Parses a 'YYYY-MM-DD' date as a UTC calendar date (no time-zone drift). */
function parseDateUTC(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDateUTC(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDaysUTC(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/** Weekend = Friday (5) or Saturday (6), per spec. */
function isWeekendNight(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 5 || day === 6;
}

function findRoomRate(roomRates: RoomRateRow[], guests: number): RoomRateRow | undefined {
  const exact = roomRates.find((r) => r.occupancy === guests);
  if (exact) return exact;

  // Fallback: the max-occupancy row.
  return roomRates.reduce<RoomRateRow | undefined>((max, r) => {
    if (!max || r.occupancy > max.occupancy) return r;
    return max;
  }, undefined);
}

export function calculatePrice(input: CalculatePriceInput): CalculatePriceResult {
  const { checkIn, checkOut, guests, roomRates, rateOverrides, roomDefaultMinStay } = input;

  const checkInDate = parseDateUTC(checkIn);
  const checkOutDate = parseDateUTC(checkOut);
  const requestedNights = Math.round((checkOutDate.getTime() - checkInDate.getTime()) / 86_400_000);

  const overridesByDate = new Map(rateOverrides.map((o) => [o.date, o]));

  // Min-stay: applies the override on the check-in date, else the room's default.
  const checkInOverride = overridesByDate.get(checkIn);
  const requiredMinStay = checkInOverride?.minStay ?? roomDefaultMinStay;
  if (requestedNights < requiredMinStay) {
    return {
      status: 'unavailable_min_stay',
      requiredMinStay,
      requestedNights,
    };
  }

  let totalCents = 0;
  let cursor = checkInDate;
  while (cursor.getTime() < checkOutDate.getTime()) {
    const nightDate = formatDateUTC(cursor);
    const override = overridesByDate.get(nightDate);

    if (override?.closed) {
      return { status: 'unavailable_closed', closedDate: nightDate };
    }

    if (override?.priceCents != null) {
      totalCents += override.priceCents;
    } else {
      const rate = findRoomRate(roomRates, guests);
      if (!rate) {
        throw new Error('No room_rates row available to price this stay (room has no rates configured).');
      }
      totalCents += isWeekendNight(cursor) ? rate.weekendCents : rate.weekdayCents;
    }

    cursor = addDaysUTC(cursor, 1);
  }

  return { status: 'available', totalCents, nights: requestedNights };
}
