import { describe, expect, it } from 'vitest';
import { isReservationNightUniqueViolation } from '../isReservationNightUniqueViolation.js';

describe('isReservationNightUniqueViolation', () => {
  it('true for the exact reservation_night constraint', () => {
    expect(isReservationNightUniqueViolation({ code: '23505', constraint: 'reservation_nights_reservation_night_unique' })).toBe(
      true,
    );
  });

  it('false for the OTHER unique constraint (unit_night) — the includes() trap', () => {
    // 'reservation_nights_unit_night_unique'.includes('reservation_night') is
    // TRUE, so a naive substring match would wrongly match here too.
    expect(isReservationNightUniqueViolation({ code: '23505', constraint: 'reservation_nights_unit_night_unique' })).toBe(
      false,
    );
  });

  it('false for a foreign-key violation (23503) even with a matching constraint name', () => {
    expect(isReservationNightUniqueViolation({ code: '23503', constraint: 'reservation_nights_reservation_night_unique' })).toBe(
      false,
    );
  });

  it('false for null/non-object errors', () => {
    expect(isReservationNightUniqueViolation(null)).toBe(false);
    expect(isReservationNightUniqueViolation(undefined)).toBe(false);
    expect(isReservationNightUniqueViolation('boom')).toBe(false);
    expect(isReservationNightUniqueViolation(new Error('boom'))).toBe(false);
  });
});
