import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// Defense in depth on top of the advisory lock in
// src/reservations/createOrReusePayment.ts: that lock is what actually
// prevents two concurrent requests from both charging the guest, but this
// constraint guarantees the invariant at the DB level too — no code path
// (a bug, a future script, a manual fix) can ever leave two `pending`
// payments for the same reservation, even if it forgets to take the lock.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createIndex('payments', 'reservation_id', {
    name: 'idx_payments_one_pending_per_reservation',
    unique: true,
    where: "status = 'pending'",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('payments', 'reservation_id', {
    name: 'idx_payments_one_pending_per_reservation',
    ifExists: true,
  });
}
