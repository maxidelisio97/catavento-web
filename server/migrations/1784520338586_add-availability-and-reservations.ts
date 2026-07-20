import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('rooms', {
    total_units: { type: 'integer', notNull: true, default: 1, check: 'total_units >= 0' },
  });

  pgm.sql(`UPDATE rooms SET total_units = 6 WHERE name = 'Casal'`);
  pgm.sql(`UPDATE rooms SET total_units = 3 WHERE name = 'Triplo'`);
  pgm.sql(`UPDATE rooms SET total_units = 2 WHERE name = 'Quádruplo'`);

  pgm.addColumn('rate_overrides', {
    units_available: { type: 'integer', check: 'units_available >= 0' },
  });

  pgm.createTable('reservations', {
    id: 'id',
    room_id: {
      type: 'integer',
      notNull: true,
      references: 'rooms',
    },
    check_in: { type: 'date', notNull: true },
    check_out: { type: 'date', notNull: true },
    guests: { type: 'integer', notNull: true, check: 'guests >= 1' },
    status: {
      type: 'text',
      notNull: true,
      default: 'pending_payment',
      check: "status IN ('pending_payment','confirmed','cancelled')",
    },
    expires_at: { type: 'timestamptz' },
    total_cents: { type: 'integer', notNull: true, check: 'total_cents >= 0' },
    guest_name: { type: 'text' },
    guest_email: { type: 'text' },
    guest_phone: { type: 'text' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('reservations', 'reservations_check_out_after_check_in', {
    check: 'check_out > check_in',
  });

  pgm.createIndex('reservations', ['room_id', 'check_in', 'check_out'], {
    name: 'idx_reservations_room_dates',
  });
  pgm.createIndex('reservations', 'status', { name: 'idx_reservations_status' });

  pgm.createTrigger('reservations', 'reservations_set_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    function: 'set_updated_at',
    level: 'ROW',
  });
}
