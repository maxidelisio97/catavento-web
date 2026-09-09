import { describe, expect, it } from 'vitest';
import { calculateNightlyRates, type NightlyRateOverrideRow, type NightlyRoomRateRow } from '../calculateNightlyRates.js';

const casalRates: NightlyRoomRateRow[] = [
  { occupancy: 1, weekdayCents: 15000, weekendCents: 18000 },
  { occupancy: 2, weekdayCents: 20000, weekendCents: 25000 },
];

describe('calculateNightlyRates', () => {
  it('returns weekday/weekend rates for every configured occupancy, per night', () => {
    // 2026-07-16 Thu -> 2026-07-18 Sat (exclusive of checkout): Thu (weekday), Fri (weekend).
    const nights = calculateNightlyRates({
      checkIn: '2026-07-16',
      checkOut: '2026-07-18',
      roomRates: casalRates,
      rateOverrides: [],
      roomDefaultMinStay: 1,
    });

    expect(nights).toEqual([
      {
        date: '2026-07-16',
        closed: false,
        minStay: 1,
        ratesByOccupancy: [
          { occupancy: 1, priceCents: 15000 },
          { occupancy: 2, priceCents: 20000 },
        ],
      },
      {
        date: '2026-07-17',
        closed: false,
        minStay: 1,
        ratesByOccupancy: [
          { occupancy: 1, priceCents: 18000 },
          { occupancy: 2, priceCents: 25000 },
        ],
      },
    ]);
  });

  it('a price override on one night replaces every occupancy row with the same flat price', () => {
    const overrides: NightlyRateOverrideRow[] = [{ date: '2026-07-16', priceCents: 99900, minStay: null, closed: false }];

    const nights = calculateNightlyRates({
      checkIn: '2026-07-16',
      checkOut: '2026-07-17',
      roomRates: casalRates,
      rateOverrides: overrides,
      roomDefaultMinStay: 1,
    });

    expect(nights).toEqual([
      {
        date: '2026-07-16',
        closed: false,
        minStay: 1,
        ratesByOccupancy: [
          { occupancy: 1, priceCents: 99900 },
          { occupancy: 2, priceCents: 99900 },
        ],
      },
    ]);
  });

  it('a min_stay override on one night applies only to that night, falling back to the room default elsewhere', () => {
    const overrides: NightlyRateOverrideRow[] = [{ date: '2026-07-16', priceCents: null, minStay: 3, closed: false }];

    const nights = calculateNightlyRates({
      checkIn: '2026-07-16',
      checkOut: '2026-07-18',
      roomRates: casalRates,
      rateOverrides: overrides,
      roomDefaultMinStay: 1,
    });

    expect(nights.map((n) => n.minStay)).toEqual([3, 1]);
  });

  it('a closed night is reported closed:true, not omitted', () => {
    const overrides: NightlyRateOverrideRow[] = [{ date: '2026-07-16', priceCents: null, minStay: null, closed: true }];

    const nights = calculateNightlyRates({
      checkIn: '2026-07-16',
      checkOut: '2026-07-17',
      roomRates: casalRates,
      rateOverrides: overrides,
      roomDefaultMinStay: 1,
    });

    expect(nights[0].closed).toBe(true);
    // Still carries a real price per occupancy — Channex needs both stop_sell AND a rate.
    expect(nights[0].ratesByOccupancy).toEqual([
      { occupancy: 1, priceCents: 15000 },
      { occupancy: 2, priceCents: 20000 },
    ]);
  });
});
