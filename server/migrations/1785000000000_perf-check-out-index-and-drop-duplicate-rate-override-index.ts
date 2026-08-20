import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// Approved from the prior performance audit (measured with EXPLAIN ANALYZE,
// not re-measured here — see server/CLAUDE.md rendimiento-y-consultas).
// Held back until 9A merged to main to avoid colliding migrations.
export async function up(pgm: MigrationBuilder): Promise<void> {
  // -74% on the tape chart "hoy" summary, which filters/sorts reservations
  // by check_out and had no index covering it on its own (only the
  // composite idx_reservations_room_dates, which is unusable for a
  // check_out-only predicate since room_id/check_in lead it).
  pgm.createIndex('reservations', 'check_out', { name: 'idx_reservations_check_out' });

  // Dead weight on every rate_overrides write: idx_rate_overrides_room_date
  // duplicates rate_overrides_room_id_date_key (UNIQUE on the same
  // (room_id, date) columns), which Postgres already backs with its own
  // index. No query needs a second one.
  pgm.dropIndex('rate_overrides', ['room_id', 'date'], { name: 'idx_rate_overrides_room_date' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.createIndex('rate_overrides', ['room_id', 'date'], {
    name: 'idx_rate_overrides_room_date',
  });
  pgm.dropIndex('reservations', 'check_out', { name: 'idx_reservations_check_out' });
}
