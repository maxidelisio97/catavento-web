/**
 * Detects a violation of `idx_payments_one_pending_per_reservation`
 * (migration 1784587500000) — a UNIQUE index on `payments.reservation_id
 * WHERE status='pending'`, not scoped by `kind`. Mirrors
 * `isUnitNightUniqueViolation.ts` — same shape, different constraint.
 *
 * Risk-review finding on fix-asaas-overpayment-webhook: `assertNotOverpayingWithPendingAsaas`
 * closes the money side of a same-day different-kind double-pending attempt
 * (deposit + balance, both still pending), but when the combined amount
 * still fits under `balance_due_cents` the guard lets a second `pending`
 * INSERT through — and this index rejects it anyway, since it's not
 * kind-scoped. Without this, that INSERT surfaces as a raw unhandled
 * unique-violation (500) instead of the same clean OVERPAYMENT/422 the
 * guard produces for the case it does catch.
 */
interface PgUniqueViolation {
  code: string;
  constraint?: string;
}

export function isPendingPaymentUniqueViolation(err: unknown): err is PgUniqueViolation {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as PgUniqueViolation).code === '23505' &&
    ((err as PgUniqueViolation).constraint?.includes('idx_payments_one_pending_per_reservation') ?? false)
  );
}
