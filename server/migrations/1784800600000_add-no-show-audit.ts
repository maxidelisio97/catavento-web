import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// SPEC-modulo-7-gestion-operativa.md § 8, § 9 — closes a gap left by 7A's
// audit migration (1784800100000_add-reservation-states-and-audit.ts): that
// migration added `*_at`/`*_by` pairs for checked_in, checked_out and
// cancelled, but not for no_show, even though § 3's state machine and § 8
// both list it as a real terminal transition an operator triggers. Every
// other M7 write records who and when (§ 9's "opción liviana") — no_show
// must not be the one silent exception. Mirrors `cancelled_at`/`cancelled_by`
// exactly, no `reason` column: § 8 gives no-show a `reason?: string` in its
// endpoint body just like cancel, but nothing in the spec suggests it needs
// a SEPARATE reason field from cancel's — reusing `cancel_reason` for both
// terminal "didn't happen" transitions avoids a second free-text column that
// would mean the same thing.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('reservations', {
    no_show_at: { type: 'timestamptz' },
    no_show_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('reservations', ['no_show_at', 'no_show_by']);
}
