import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// Approved schema (SPEC-modulo-5-unidades-fisicas.md, project owner
// 2026-07-21): physical units per room type, assigned per reservation at
// creation time (pending_payment already retains inventory — see spec §
// "Decisión clave: cuándo se asigna la unidad").
//
// `rooms.total_units` stops being the source of truth for availability —
// the count of active `room_units` is (see repository.ts fetchRoomStayData).
// The column stays in the table (no drop, no sync trigger) and is
// backfilled here purely for cleanliness — it is not load-bearing.
//
// `room_unit_id` is nullable on purpose: historical reservation rows have
// none, and the spec allows a pending_payment to theoretically exist
// without one, though every reservation created from this module forward
// will have one.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('room_units', {
    id: 'id',
    room_id: {
      type: 'integer',
      notNull: true,
      references: 'rooms',
      onDelete: 'no action',
    },
    label: { type: 'text', notNull: true, unique: true },
    active: { type: 'boolean', notNull: true, default: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('room_units', 'room_id', { name: 'idx_room_units_room' });

  pgm.addColumn('reservations', {
    room_unit_id: { type: 'integer', references: 'room_units', onDelete: 'no action' },
  });
  pgm.createIndex('reservations', ['room_unit_id', 'check_in', 'check_out'], {
    name: 'idx_reservations_unit_dates',
  });

  // Real inventory (spec § "Decisiones de negocio"), seeded idempotently and
  // matched to room by name. Mixed 1-digit/3-digit numbering is correct —
  // it's how the pousada actually names the units. Fails loudly (not
  // silently) if a room name doesn't match or a per-type count is off,
  // same pattern as the adults-only migration.
  pgm.sql(`
    DO $$
    DECLARE
      casal_id integer;
      triplo_id integer;
      quadruplo_id integer;
      unit_count integer;
    BEGIN
      SELECT id INTO casal_id FROM rooms WHERE name = 'Casal';
      SELECT id INTO triplo_id FROM rooms WHERE name = 'Triplo';
      SELECT id INTO quadruplo_id FROM rooms WHERE name = 'Quádruplo';

      IF casal_id IS NULL THEN
        RAISE EXCEPTION 'Expected a room named ''Casal'' to seed room_units, found none';
      END IF;
      IF triplo_id IS NULL THEN
        RAISE EXCEPTION 'Expected a room named ''Triplo'' to seed room_units, found none';
      END IF;
      IF quadruplo_id IS NULL THEN
        RAISE EXCEPTION 'Expected a room named ''Quádruplo'' to seed room_units, found none';
      END IF;

      INSERT INTO room_units (room_id, label) VALUES
        (casal_id, '101'), (casal_id, '102'), (casal_id, '103'),
        (casal_id, '104'), (casal_id, '105'), (casal_id, '106'),
        (triplo_id, '7'), (triplo_id, '8'), (triplo_id, '9'),
        (quadruplo_id, '10'), (quadruplo_id, '11')
      ON CONFLICT (label) DO NOTHING;

      SELECT count(*) INTO unit_count FROM room_units WHERE room_id = casal_id;
      IF unit_count <> 6 THEN
        RAISE EXCEPTION 'Expected 6 room_units for Casal, found %', unit_count;
      END IF;

      SELECT count(*) INTO unit_count FROM room_units WHERE room_id = triplo_id;
      IF unit_count <> 3 THEN
        RAISE EXCEPTION 'Expected 3 room_units for Triplo, found %', unit_count;
      END IF;

      SELECT count(*) INTO unit_count FROM room_units WHERE room_id = quadruplo_id;
      IF unit_count <> 2 THEN
        RAISE EXCEPTION 'Expected 2 room_units for Quádruplo, found %', unit_count;
      END IF;
    END $$;
  `);

  // Cleanliness only — the availability/assignment path no longer reads this
  // column. Scoped to only the three rooms this migration actually seeded:
  // an unscoped UPDATE over all of `rooms` would silently zero total_units
  // on any other room row (a test fixture, a future room type) that isn't
  // one of these three, with no assert to catch it.
  pgm.sql(`
    UPDATE rooms SET total_units = (
      SELECT count(*) FROM room_units WHERE room_units.room_id = rooms.id AND room_units.active
    )
    WHERE id IN (
      SELECT id FROM rooms WHERE name IN ('Casal', 'Triplo', 'Quádruplo')
    );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('reservations', ['room_unit_id', 'check_in', 'check_out'], {
    name: 'idx_reservations_unit_dates',
  });
  pgm.dropColumn('reservations', 'room_unit_id');
  pgm.dropIndex('room_units', 'room_id', { name: 'idx_room_units_room' });
  pgm.dropTable('room_units');
}
