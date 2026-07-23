import { describe, expect, it } from 'vitest';
import {
  assertValidTransition,
  InvalidReservationTransitionError,
  isValidTransition,
  type ReservationStatus,
} from '../reservationStateMachine.js';

const ALL_STATUSES: ReservationStatus[] = [
  'pending_payment',
  'confirmed',
  'cancelled',
  'payment_conflict',
  'checked_in',
  'checked_out',
  'no_show',
];

describe('reservationStateMachine', () => {
  it.each([
    ['pending_payment', 'confirmed'],
    ['pending_payment', 'cancelled'],
    ['confirmed', 'checked_in'],
    ['confirmed', 'cancelled'],
    ['confirmed', 'no_show'],
    ['checked_in', 'checked_out'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(isValidTransition(from, to)).toBe(true);
    expect(() => assertValidTransition(from, to)).not.toThrow();
  });

  // SPEC § 3: checked_in never goes back to cancelled/no_show — the guest is
  // already inside.
  it.each(['cancelled', 'no_show'] as const)('rejects checked_in -> %s', (to) => {
    expect(isValidTransition('checked_in', to)).toBe(false);
    expect(() => assertValidTransition('checked_in', to)).toThrow(InvalidReservationTransitionError);
  });

  // SPEC § 3: checked_out, cancelled, no_show are terminal states.
  it.each(['checked_out', 'cancelled', 'no_show'] as const)('rejects any transition out of terminal state %s', (from) => {
    for (const to of ALL_STATUSES) {
      expect(isValidTransition(from, to)).toBe(false);
    }
  });

  // SPEC § 0: payment_conflict is M4's, untouched by M7 — no transitions in
  // or out defined by this state machine.
  it('rejects any transition out of payment_conflict', () => {
    for (const to of ALL_STATUSES) {
      expect(isValidTransition('payment_conflict', to)).toBe(false);
    }
  });

  it('rejects a skip from confirmed straight to checked_out', () => {
    expect(isValidTransition('confirmed', 'checked_out')).toBe(false);
  });

  it('throws InvalidReservationTransitionError with the offending from/to on the error object', () => {
    try {
      assertValidTransition('confirmed', 'checked_out');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidReservationTransitionError);
      const transitionError = err as InvalidReservationTransitionError;
      expect(transitionError.from).toBe('confirmed');
      expect(transitionError.to).toBe('checked_out');
    }
  });
});
