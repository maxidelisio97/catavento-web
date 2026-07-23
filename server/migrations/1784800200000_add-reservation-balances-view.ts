import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// SPEC-modulo-7-gestion-operativa.md § 5.3 — balance is calculated, never
// materialized, so it can't drift from `payments`.
//
// Deviation from the spec's literal SQL (approved 2026-07-22): the spec
// filters `WHERE p.status='confirmed'`, but `payments.status` (M4) never has
// that value — the real "money actually received" value is `'received'`
// (`CHECK status IN ('pending','received','failed','refunded')`). Filtering
// on 'confirmed' would silently sum zero payments for every reservation,
// making `balance_due_cents` always equal `total_cents` and unblocking
// check-out (§ 6.2) for everyone regardless of what was actually paid.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createView('reservation_balances', {}, `
    SELECT
      r.id AS reservation_id,
      r.code,
      r.total_cents,
      COALESCE(SUM(p.amount_cents) FILTER (WHERE p.status = 'received'), 0) AS amount_paid_cents,
      r.total_cents - COALESCE(SUM(p.amount_cents) FILTER (WHERE p.status = 'received'), 0) AS balance_due_cents
    FROM reservations r
    LEFT JOIN payments p ON p.reservation_id = r.id
    GROUP BY r.id
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropView('reservation_balances');
}
