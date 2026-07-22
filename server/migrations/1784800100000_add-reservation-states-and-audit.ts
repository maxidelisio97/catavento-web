import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// SPEC-modulo-7-gestion-operativa.md § 3, § 7.1 dec.1, § 10 dec.1, § 11 —
// operational state machine (check-in/check-out/no-show) and light-weight
// audit trail for panel writes.
//
// Deviation from the spec's literal SQL (approved 2026-07-22): the spec's
// diagram uses `pending` as shorthand for the real column value
// `pending_payment` (M4), and lists `cancelled` as a "new" state that
// `reservations_status_check` already allows since M4. The only states
// actually new here are `checked_in`, `checked_out`, `no_show`.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE reservations DROP CONSTRAINT reservations_status_check`);
  pgm.sql(`
    ALTER TABLE reservations ADD CONSTRAINT reservations_status_check
      CHECK (status IN (
        'pending_payment','confirmed','cancelled','payment_conflict',
        'checked_in','checked_out','no_show'
      ))
  `);

  pgm.addColumn('reservations', {
    checked_in_at: { type: 'timestamptz' },
    checked_in_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    checked_out_at: { type: 'timestamptz' },
    checked_out_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    cancelled_at: { type: 'timestamptz' },
    cancelled_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    cancel_reason: { type: 'text' },
    // null for every reservation created by the public web flow (M3/M4);
    // set only for panel-created manual reservations (§ 7).
    created_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    // null = use the calculated total (M1 rate logic). Set only when an
    // operator overrides the price of a manual reservation (§ 10 dec.1).
    override_total_cents: { type: 'integer', check: 'override_total_cents >= 0' },
  });

  // § 11, § 5.3: extra charges (laundry, late check-out, ...) that add to a
  // reservation's total. `total_cents` stays the frozen source of truth (same
  // pattern as `deposit_cents`) — the application updates it in the same
  // transaction/lock as the extra insert (§ 5.3, § 10 dec.1 follow-up), the
  // `reservation_balances` view never sums this table itself.
  pgm.createTable('reservation_extras', {
    id: 'id',
    reservation_id: {
      type: 'integer',
      notNull: true,
      references: 'reservations',
      onDelete: 'cascade',
    },
    concept: { type: 'text', notNull: true },
    amount_cents: { type: 'integer', notNull: true, check: 'amount_cents > 0' },
    created_by: { type: 'integer', notNull: true, references: 'users' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('reservation_extras', 'reservation_id', { name: 'idx_reservation_extras_reservation' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('reservation_extras');

  pgm.dropColumn('reservations', [
    'checked_in_at',
    'checked_in_by',
    'checked_out_at',
    'checked_out_by',
    'cancelled_at',
    'cancelled_by',
    'cancel_reason',
    'created_by',
    'override_total_cents',
  ]);

  pgm.sql(`ALTER TABLE reservations DROP CONSTRAINT reservations_status_check`);
  pgm.sql(`
    ALTER TABLE reservations ADD CONSTRAINT reservations_status_check
      CHECK (status IN ('pending_payment','confirmed','cancelled','payment_conflict'))
  `);
}
