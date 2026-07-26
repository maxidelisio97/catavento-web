import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// Risk-review finding on fix-asaas-overpayment-webhook: assertNotOverpaying
// only guards charge CREATION — Asaas money lands later via webhook, with no
// re-validation. Once the webhook confirms a payment that pushes
// balance_due_cents negative, the money is already captured by Asaas (no
// refund endpoint exists yet) — rejecting the webhook can't undo the
// capture, it would only desync our ledger from what Asaas actually holds.
// So this is a flag, not a rejection: a visible trail for the manual refund,
// not a prevention mechanism (prevention lives in overpaymentGuard.ts,
// checked at charge-creation time instead).
//
// The excess is snapshotted at flag time, not recomputed later, because
// `reservation_balances` is a live view — by the time an operator reviews a
// flagged payment, another payment or extra may have already changed
// balance_due_cents, and the snapshot is the only record of what the excess
// actually was at the moment this payment tipped it negative.
//
// Deliberately NOT reusing `reservations.status = 'payment_conflict'`: that
// status means "the physical unit became unavailable", a completely
// different failure mode. Overloading it with "we collected too much money"
// would be the same stale/ambiguous-status mistake this project has already
// been bitten by — this is its own column on `payments`, not a reservation
// state.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('payments', {
    flagged_overpayment: { type: 'boolean', notNull: true, default: false },
    flagged_overpayment_at: { type: 'timestamptz' },
    flagged_overpayment_excess_cents: { type: 'integer' },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('payments', ['flagged_overpayment', 'flagged_overpayment_at', 'flagged_overpayment_excess_cents']);
}
