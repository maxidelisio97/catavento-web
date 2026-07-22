import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';
import { EXPAND_RESERVATION_NIGHTS_SQL } from '../src/availability/expandReservationNightsSql.js';

export const shorthands: ColumnDefinitions | undefined = undefined;

// Approved schema (SPEC-modulo-6-panel-base.md § "ENTREGA 6A — Asignación de
// unidad por noche", project owner 2026-07-21): unit assignment moves from
// "one unit for the whole stay" (reservations.room_unit_id) to "one unit per
// night" (reservation_nights). This is what lets a future module (M7) move a
// single night without splitting the reservation.
//
// Date convention (also documented in isReservationActive.ts and
// createReservation.ts): a reservation with check_in = 2026-08-10 and
// check_out = 2026-08-13 generates rows for nights 10, 11, 12. check_out
// NEVER generates a row. Row count = number of nights = check_out - check_in.
//
// reservations.room_unit_id is NOT dropped here. It stays as a deprecated/
// legacy column, still written by createReservation (set to the unit of the
// first night — trivial today since 6A still assigns a single unit to the
// whole stay at creation time). All NEW reads use reservation_nights. This
// avoids a forgotten M5-era read path breaking silently, and allows a
// rollback of 6A without losing information. Its removal is evaluated in M7.
export async function up(pgm: MigrationBuilder): Promise<void> {
  // Deviation from the spec's literal "bigint" column types: every existing
  // table in this repo (reservations, room_units, ...) uses the 'id'
  // shorthand, which creates a serial (integer) primary key — see e.g.
  // migrations/1784636400000_add-room-units-and-assignment.ts. FK columns
  // here use 'integer' to match those actual PK types, consistent with how
  // reservations.room_unit_id already references room_units.id. Using
  // 'bigint' would still work (Postgres allows it), but would be
  // inconsistent with every other FK in this schema for no benefit.
  pgm.createTable('reservation_nights', {
    id: 'id',
    reservation_id: {
      type: 'integer',
      notNull: true,
      references: 'reservations',
      onDelete: 'cascade',
    },
    // The calendar date of the night itself — the night of the 10th is the
    // night from the 10th to the 11th. Never the checkout date (see
    // convention above).
    night: { type: 'date', notNull: true },
    room_unit_id: {
      type: 'integer',
      notNull: true,
      references: 'room_units',
      onDelete: 'no action',
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('reservation_nights', 'reservation_nights_reservation_night_unique', {
    unique: ['reservation_id', 'night'],
  });

  // The central piece: this is anti-overbooking enforced by the database
  // itself, not just by the application's lock. Two reservations can never
  // occupy the same physical unit on the same night, full stop — no removing
  // this "to optimize" later (see server/CLAUDE.md addition proposed at the
  // end of this module).
  pgm.addConstraint('reservation_nights', 'reservation_nights_unit_night_unique', {
    unique: ['room_unit_id', 'night'],
  });

  pgm.createIndex('reservation_nights', 'night', { name: 'idx_reservation_nights_night' });
  pgm.createIndex('reservation_nights', ['room_unit_id', 'night'], {
    name: 'idx_reservation_nights_unit_night',
  });

  pgm.addColumn('reservations', {
    origin: {
      type: 'text',
      notNull: true,
      default: 'web',
      check: "origin IN ('web','manual','ota')",
    },
  });

  // Data migration: expand every currently-active reservation (confirmed, or
  // pending_payment with a still-future expires_at) that has a non-null
  // room_unit_id into one reservation_nights row per night, all with that
  // same unit (today's single-unit-per-stay model). Cancelled and expired-
  // pending reservations are deliberately NOT migrated — they don't occupy
  // inventory.
  //
  // Idempotent via ON CONFLICT DO NOTHING on (reservation_id, night), so this
  // migration can be re-run (e.g. after a partial failure) with no duplicate
  // rows and no additional effect.
  //
  // CRITICAL correctness note for the post-migration assert below: it must
  // compare, PER RESERVATION, a FRESH count of reservation_nights rows
  // against the expected night count — never the number of rows the INSERT
  // statement itself reports as affected. On a re-run the INSERT affects 0
  // rows (ON CONFLICT DO NOTHING short-circuits already-migrated rows) while
  // the actual persisted row count for that reservation is still correct —
  // asserting on "rows inserted this statement" would wrongly fail that
  // (perfectly fine) re-run case.
  pgm.sql(EXPAND_RESERVATION_NIGHTS_SQL);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('reservations', 'origin');
  pgm.dropIndex('reservation_nights', ['room_unit_id', 'night'], {
    name: 'idx_reservation_nights_unit_night',
  });
  pgm.dropIndex('reservation_nights', 'night', { name: 'idx_reservation_nights_night' });
  pgm.dropTable('reservation_nights');
}
