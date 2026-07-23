import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// SPEC-modulo-7-gestion-operativa.md § 5.2 camino B, § 9 — payments registered
// by hand (method cash/external/pix_manual) never touch Asaas, so they have
// no `asaas_payment_id`. That column was NOT NULL + UNIQUE since M4 (every
// M4/M6 payment was an Asaas deposit). Postgres UNIQUE allows any number of
// NULLs (each NULL is distinct from every other value), so dropping NOT NULL
// alone is sufficient — no need to touch the unique constraint.
//
// Also adds `changed_by` (§ 9 "Opción liviana"), deferred by 7A because it
// only matters once an operator can write a payment by hand — that's 7B.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.alterColumn('payments', 'asaas_payment_id', { notNull: false });

  pgm.addColumn('payments', {
    changed_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('payments', 'changed_by');
  pgm.alterColumn('payments', 'asaas_payment_id', { notNull: true });
}
