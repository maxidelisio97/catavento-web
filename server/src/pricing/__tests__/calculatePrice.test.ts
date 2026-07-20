import { describe, expect, it } from 'vitest';
import { calculatePrice, type RateOverrideRow, type RoomRateRow } from '../calculatePrice.js';

// Triplo-like rates: occupancy 3, weekday 20000, weekend 25000.
const triploRates: RoomRateRow[] = [
  { occupancy: 3, weekdayCents: 20000, weekendCents: 25000 },
];

const noOverrides: RateOverrideRow[] = [];

describe('calculatePrice', () => {
  it('prices a stay entirely within weekdays (no weekend nights)', () => {
    // 2026-07-13 is a Monday; stay Mon-Thu = 3 weekday nights.
    const result = calculatePrice({
      checkIn: '2026-07-13',
      checkOut: '2026-07-16',
      guests: 3,
      roomRates: triploRates,
      rateOverrides: noOverrides,
      roomDefaultMinStay: 1,
    });

    expect(result).toEqual({ status: 'available', totalCents: 3 * 20000, nights: 3 });
  });

  it('applies weekend pricing to a stay that crosses Friday+Saturday', () => {
    // 2026-07-16 is Thursday, checkout 2026-07-20 (Monday):
    // nights = Thu, Fri, Sat, Sun -> 2 weekday + 2 weekend.
    const result = calculatePrice({
      checkIn: '2026-07-16',
      checkOut: '2026-07-20',
      guests: 3,
      roomRates: triploRates,
      rateOverrides: noOverrides,
      roomDefaultMinStay: 1,
    });

    expect(result).toEqual({
      status: 'available',
      totalCents: 2 * 20000 + 2 * 25000,
      nights: 4,
    });
  });

  it('applies a price override on one night within the range', () => {
    // Mon-Thu stay (3 weekday nights), with 2026-07-14 overridden to 99900.
    const overrides: RateOverrideRow[] = [
      { date: '2026-07-14', priceCents: 99900, minStay: null, closed: false },
    ];

    const result = calculatePrice({
      checkIn: '2026-07-13',
      checkOut: '2026-07-16',
      guests: 3,
      roomRates: triploRates,
      rateOverrides: overrides,
      roomDefaultMinStay: 1,
    });

    expect(result).toEqual({
      status: 'available',
      totalCents: 20000 + 99900 + 20000,
      nights: 3,
    });
  });

  it('reports unavailable when a closed night falls within the range', () => {
    const overrides: RateOverrideRow[] = [
      { date: '2026-07-14', priceCents: null, minStay: null, closed: true },
    ];

    const result = calculatePrice({
      checkIn: '2026-07-13',
      checkOut: '2026-07-16',
      guests: 3,
      roomRates: triploRates,
      rateOverrides: overrides,
      roomDefaultMinStay: 1,
    });

    expect(result).toEqual({ status: 'unavailable_closed', closedDate: '2026-07-14' });
  });

  it('rejects a too-short stay when the check-in date has a min_stay override', () => {
    const overrides: RateOverrideRow[] = [
      { date: '2026-07-13', priceCents: null, minStay: 3, closed: false },
    ];

    // Requesting only 2 nights, but the override on check-in requires 3.
    const result = calculatePrice({
      checkIn: '2026-07-13',
      checkOut: '2026-07-15',
      guests: 3,
      roomRates: triploRates,
      rateOverrides: overrides,
      roomDefaultMinStay: 1,
    });

    expect(result).toEqual({
      status: 'unavailable_min_stay',
      requiredMinStay: 3,
      requestedNights: 2,
    });
  });

  it('falls back to the max-occupancy rate when the requested guest count has no matching row', () => {
    const multiOccupancyRates: RoomRateRow[] = [
      { occupancy: 2, weekdayCents: 18000, weekendCents: 22000 },
      { occupancy: 4, weekdayCents: 23000, weekendCents: 30000 },
    ];

    // Requesting for 1 guest (no row for occupancy 1) -> falls back to max occupancy (4).
    const result = calculatePrice({
      checkIn: '2026-07-13',
      checkOut: '2026-07-14',
      guests: 1,
      roomRates: multiOccupancyRates,
      rateOverrides: noOverrides,
      roomDefaultMinStay: 1,
    });

    expect(result).toEqual({ status: 'available', totalCents: 23000, nights: 1 });
  });
});
