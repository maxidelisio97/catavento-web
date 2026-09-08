import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// SPEC-modulo-12B-reservas-entrantes.md § 4 — OTA reservations live as
// ordinary `reservations`/`reservation_nights` rows (`origin='ota'`, already
// allowed since the 6A migration). This migration only adds:
// 1. `ota_conflict` to `reservations_status_check` — same mechanism as
//    `payment_conflict` (M4): a reservation with no `reservation_nights`
//    rows, excluded from disponibilidad, waiting for manual resolution.
// 2. Channex traceability columns for idempotency (§ 1.1): `channex_booking_id`
//    identifies the OTA's booking (stable across revisions), `channex_last_revision_id`
//    is the last revision actually applied — a later delivery of an
//    already-applied revision is a no-op.
// Columns, not a separate table (`channex_processed_revisions`): a booking
// revision always targets exactly one local reservation, so this is a 1:1
// relationship naturally expressed as columns on `reservations` — a join
// table would only add a round trip with no dedupe benefit.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE reservations DROP CONSTRAINT reservations_status_check`);
  pgm.sql(`
    ALTER TABLE reservations ADD CONSTRAINT reservations_status_check
      CHECK (status IN (
        'pending_payment','confirmed','cancelled','payment_conflict',
        'checked_in','checked_out','no_show','ota_conflict'
      ))
  `);

  pgm.addColumn('reservations', {
    channex_booking_id: { type: 'text' },
    channex_last_revision_id: { type: 'text' },
  });

  // Partial unique index (not a table-wide UNIQUE): only OTA reservations
  // ever populate this column, and a plain UNIQUE constraint in Postgres
  // already treats multiple NULLs as non-conflicting — but a partial index
  // keeps the intent explicit and matches the pattern used for
  // `channex_room_type_id` (1785400000000).
  pgm.createIndex('reservations', 'channex_booking_id', {
    name: 'idx_reservations_channex_booking_id_unique',
    unique: true,
    where: 'channex_booking_id IS NOT NULL',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('reservations', 'channex_booking_id', {
    name: 'idx_reservations_channex_booking_id_unique',
    ifExists: true,
  });
  pgm.dropColumn('reservations', ['channex_booking_id', 'channex_last_revision_id']);

  pgm.sql(`ALTER TABLE reservations DROP CONSTRAINT reservations_status_check`);
  pgm.sql(`
    ALTER TABLE reservations ADD CONSTRAINT reservations_status_check
      CHECK (status IN (
        'pending_payment','confirmed','cancelled','payment_conflict',
        'checked_in','checked_out','no_show'
      ))
  `);
}
