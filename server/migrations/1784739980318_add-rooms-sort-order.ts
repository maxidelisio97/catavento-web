import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// SPEC-modulo-6-panel-base.md § 6C.1: the tape chart groups unit rows by
// room type (Casal, Triplo, Quádruplo) in a fixed display order. Storing
// that order as data — rather than a CASE on `rooms.name` inside the
// tape-chart query — means renaming a room type (already possible from the
// panel starting módulo 8) can't silently scramble the grid order.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('rooms', {
    sort_order: { type: 'integer', notNull: true, default: 0 },
  });

  pgm.sql(`
    UPDATE rooms SET sort_order = CASE name
      WHEN 'Casal' THEN 1
      WHEN 'Triplo' THEN 2
      WHEN 'Quádruplo' THEN 3
      ELSE sort_order
    END
    WHERE name IN ('Casal', 'Triplo', 'Quádruplo');
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('rooms', 'sort_order');
}
