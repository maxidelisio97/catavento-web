import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// SPEC-modulo-7-gestion-operativa.md § 7.2b — pets field + fare component.
// Closes the 7C debt: `moveReservation.ts` couldn't enforce the pets-vs-Casal
// rule because `reservations` had no column recording whether a stay brings
// a pet (only `rooms.pets_allowed` existed, from M1). Mirrors the
// children/babies mold (M6, `add-children-babies-and-adults-only`): a plain
// column on `reservations`, no new catalog table.
//
// `pet_fee_cents` is frozen separately from `total_cents` (not folded in
// silently) so it stays auditable independent of `override_total_cents` —
// same rationale as `deposit_cents` being its own column instead of being
// implied by `total_cents` alone.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('reservations', {
    pets: { type: 'boolean', notNull: true, default: false },
    // Frozen at creation = nights × settings.pet_fee_cents at that moment.
    // Never recalculated by move (§7.2b: a move never touches total_cents at
    // all, pets included — see moveReservation.ts's hard pets check instead).
    pet_fee_cents: { type: 'integer', notNull: true, default: 0, check: 'pet_fee_cents >= 0' },
  });

  // Business parameter as data (server/CLAUDE.md § "parámetros de negocio
  // como datos"), same table as deposit_percent/hold_minutes. Default R$30.
  pgm.sql(`INSERT INTO settings (key, value) VALUES ('pet_fee_cents', '3000')`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DELETE FROM settings WHERE key = 'pet_fee_cents'`);
  pgm.dropColumn('reservations', ['pets', 'pet_fee_cents']);
}
