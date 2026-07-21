import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// Approved schema (project owner, 2026-07-21): children/babies support.
// - rooms.adults_only: named after the business rule itself (no children,
//   no babies), not the "allows_children" symptom — Casal is adults-only,
//   Triplo/Quádruplo are not.
// - reservations.children counts toward capacity (guests = adults +
//   children, computed server-side). babies never count toward capacity
//   (they sleep with parents) and are informational only.
// - reservations.children_ages is informative data only (e.g. so staff can
//   prepare a crib) — one integer per child, range enforced at the Zod
//   boundary (3-17 inclusive; 0-2 is a baby by definition, not a child).
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('rooms', {
    adults_only: { type: 'boolean', notNull: true, default: false },
  });
  // Asserted rather than silent: if "Casal" is ever renamed, this must fail
  // loudly instead of quietly leaving the adults-only guarantee unset.
  pgm.sql(`
    DO $$
    DECLARE
      updated_count integer;
    BEGIN
      UPDATE rooms SET adults_only = true WHERE name = 'Casal';
      GET DIAGNOSTICS updated_count = ROW_COUNT;
      IF updated_count <> 1 THEN
        RAISE EXCEPTION 'Expected exactly 1 room named ''Casal'' to mark adults_only, found %', updated_count;
      END IF;
    END $$;
  `);

  pgm.addColumn('reservations', {
    children: { type: 'integer', notNull: true, default: 0, check: 'children >= 0' },
    babies: { type: 'integer', notNull: true, default: 0, check: 'babies >= 0' },
    children_ages: { type: 'integer[]', notNull: true, default: '{}' },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('reservations', ['children', 'babies', 'children_ages']);
  pgm.dropColumn('rooms', 'adults_only');
}
