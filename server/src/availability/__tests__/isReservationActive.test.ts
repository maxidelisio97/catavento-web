import { describe, expect, it } from 'vitest';
import { isReservationActive } from '../isReservationActive.js';

describe('isReservationActive', () => {
  it('a confirmed reservation is always active, regardless of expires_at', () => {
    expect(isReservationActive('confirmed', null)).toBe(true);
    expect(isReservationActive('confirmed', new Date(Date.now() - 60_000))).toBe(true);
    expect(isReservationActive('confirmed', new Date(Date.now() + 60_000))).toBe(true);
  });

  // SPEC-modulo-7-gestion-operativa.md § 7.1: a manual reservation is created
  // directly with status='confirmed' and no hold_minutes — it must NEVER be
  // picked up by the lazy expiration sweep. This function has no `origin`
  // parameter at all, so a manual reservation is indistinguishable from a web
  // one once it's `confirmed` — proving the guarantee holds independently of
  // how the reservation was created. If this test ever needs an `origin` to
  // pass, the guarantee has been broken.
  it('a confirmed reservation with an already-past expires_at (simulating a bug that left one set) is still active', () => {
    const farInThePast = new Date('2000-01-01T00:00:00Z');
    expect(isReservationActive('confirmed', farInThePast)).toBe(true);
  });

  it('a pending_payment reservation is active only while unexpired', () => {
    expect(isReservationActive('pending_payment', null)).toBe(true);
    expect(isReservationActive('pending_payment', new Date(Date.now() + 60_000))).toBe(true);
    expect(isReservationActive('pending_payment', new Date(Date.now() - 60_000))).toBe(false);
  });

  it.each(['cancelled', 'payment_conflict', 'no_show'])('%s is never active, regardless of expires_at', (status) => {
    expect(isReservationActive(status, null)).toBe(false);
    expect(isReservationActive(status, new Date(Date.now() + 60_000))).toBe(false);
  });

  it('checked_in is always active, regardless of expires_at', () => {
    expect(isReservationActive('checked_in', null)).toBe(true);
    expect(isReservationActive('checked_in', new Date(Date.now() - 60_000))).toBe(true);
  });

  // SPEC § 6.2: reservation_nights rows for a checked-out stay stay as
  // historical record and must never be swept — so checked_out must count as
  // "active" for this function's purposes, even though the guest already
  // left.
  it('checked_out is always active, regardless of expires_at (its rows are kept as historical record)', () => {
    expect(isReservationActive('checked_out', null)).toBe(true);
    expect(isReservationActive('checked_out', new Date(Date.now() - 60_000))).toBe(true);
  });
});
