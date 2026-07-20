import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Business parameters as data (server/CLAUDE.md § "parámetros de negocio
  // como datos"). value is stored as TEXT and typed in-app with Zod per key
  // (see src/settings/settings.ts) so this table stays generic.
  pgm.createTable('settings', {
    key: { type: 'text', primaryKey: true },
    value: { type: 'text', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.sql(`
    INSERT INTO settings (key, value) VALUES
      ('deposit_percent', '50'),
      ('hold_minutes', '30')
  `);

  pgm.createTrigger('settings', 'settings_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'set_updated_at',
    level: 'ROW',
  });

  // Frozen at reservation creation time (deposit_percent at that moment +
  // half-up rounding to whole reais), same pattern as total_cents. Nullable
  // for historical rows created before this module.
  pgm.addColumn('reservations', {
    deposit_cents: { type: 'integer', check: 'deposit_cents >= 0' },
  });

  // SPEC-modulo-4-pago-asaas.md § "Caso límite": a payment can arrive after
  // the reservation expired and the unit is no longer available. That
  // reservation moves to payment_conflict instead of confirmed — the unit is
  // never double-booked, and the deposit is refunded manually for now.
  pgm.sql(`ALTER TABLE reservations DROP CONSTRAINT reservations_status_check`);
  pgm.sql(`
    ALTER TABLE reservations ADD CONSTRAINT reservations_status_check
      CHECK (status IN ('pending_payment','confirmed','cancelled','payment_conflict'))
  `);

  pgm.createTable('payments', {
    id: 'id',
    reservation_id: {
      type: 'integer',
      notNull: true,
      references: 'reservations',
    },
    asaas_payment_id: { type: 'text', notNull: true, unique: true },
    method: { type: 'text', notNull: true, check: "method IN ('pix','card')" },
    amount_cents: { type: 'integer', notNull: true, check: 'amount_cents > 0' },
    status: {
      type: 'text',
      notNull: true,
      default: 'pending',
      check: "status IN ('pending','received','failed','refunded')",
    },
    // Last webhook payload received for this payment, kept for audit.
    raw_last_event: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('payments', 'reservation_id', { name: 'idx_payments_reservation' });

  pgm.createTrigger('payments', 'payments_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'set_updated_at',
    level: 'ROW',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger('payments', 'payments_set_updated_at', { ifExists: true });
  pgm.dropTable('payments');

  pgm.sql(`ALTER TABLE reservations DROP CONSTRAINT reservations_status_check`);
  pgm.sql(`
    ALTER TABLE reservations ADD CONSTRAINT reservations_status_check
      CHECK (status IN ('pending_payment','confirmed','cancelled'))
  `);

  pgm.dropColumn('reservations', 'deposit_cents');

  pgm.dropTrigger('settings', 'settings_set_updated_at', { ifExists: true });
  pgm.dropTable('settings');
}
