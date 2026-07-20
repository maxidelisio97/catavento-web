import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Reusable trigger function to maintain updated_at on any table that has that column.
  pgm.createFunction(
    'set_updated_at',
    [],
    {
      returns: 'trigger',
      language: 'plpgsql',
      replace: true,
    },
    `
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    `,
  );

  pgm.createTable('rooms', {
    id: 'id',
    name: { type: 'text', notNull: true, unique: true },
    capacity: { type: 'integer', notNull: true, check: 'capacity >= 1' },
    pets_allowed: { type: 'boolean', notNull: true, default: false },
    default_min_stay: {
      type: 'integer',
      notNull: true,
      default: 1,
      check: 'default_min_stay >= 1',
    },
    active: { type: 'boolean', notNull: true, default: true },
    description: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('room_rates', {
    id: 'id',
    room_id: {
      type: 'integer',
      notNull: true,
      references: 'rooms',
      onDelete: 'CASCADE',
    },
    occupancy: { type: 'integer', notNull: true, check: 'occupancy >= 1' },
    weekday_cents: { type: 'integer', notNull: true, check: 'weekday_cents >= 0' },
    weekend_cents: { type: 'integer', notNull: true, check: 'weekend_cents >= 0' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('room_rates', 'room_rates_room_id_occupancy_key', {
    unique: ['room_id', 'occupancy'],
  });

  pgm.createTable('rate_overrides', {
    id: 'id',
    room_id: {
      type: 'integer',
      notNull: true,
      references: 'rooms',
      onDelete: 'CASCADE',
    },
    date: { type: 'date', notNull: true },
    price_cents: { type: 'integer', check: 'price_cents >= 0' },
    min_stay: { type: 'integer', check: 'min_stay >= 1' },
    closed: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('rate_overrides', 'rate_overrides_room_id_date_key', {
    unique: ['room_id', 'date'],
  });
  pgm.createIndex('rate_overrides', ['room_id', 'date'], {
    name: 'idx_rate_overrides_room_date',
  });

  for (const table of ['rooms', 'room_rates', 'rate_overrides']) {
    pgm.createTrigger(table, `${table}_set_updated_at`, {
      when: 'BEFORE',
      operation: 'UPDATE',
      function: 'set_updated_at',
      level: 'ROW',
    });
  }
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  for (const table of ['rooms', 'room_rates', 'rate_overrides']) {
    pgm.dropTrigger(table, `${table}_set_updated_at`, { ifExists: true });
  }

  pgm.dropTable('rate_overrides');
  pgm.dropTable('room_rates');
  pgm.dropTable('rooms');

  pgm.dropFunction('set_updated_at', [], { ifExists: true });
}
