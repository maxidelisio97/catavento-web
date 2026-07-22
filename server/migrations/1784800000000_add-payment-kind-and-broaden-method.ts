import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// SPEC-modulo-7-gestion-operativa.md § 5.1, § 11 — generalize `payments` from
// "one Asaas deposit per reservation" (M4) to any payment (deposit, balance,
// extra, refund), entered either via Asaas or registered by hand by an
// operator.
//
// Deviation from the spec's literal SQL (approved 2026-07-22, see plan
// discussion): the spec's `ALTER TABLE payments ADD COLUMN method` collides
// with the `method` column M4 already created (`CHECK method IN
// ('pix','card')`). There are not two "method" concepts here — there is one,
// and M4's version is just narrower than M7 needs. Widening the existing
// CHECK and backfilling its two known values ('pix' -> 'asaas_pix', 'card' ->
// 'asaas_card') is correct; adding a second column would leave two
// overlapping sources of truth for the same fact.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('payments', {
    kind: { type: 'text', notNull: true, default: 'deposit' },
  });
  pgm.addConstraint('payments', 'payments_kind_check', {
    check: "kind IN ('deposit','balance','extra','refund')",
  });

  pgm.sql(`
    UPDATE payments SET method = 'asaas_' || method WHERE method IN ('pix','card')
  `);

  pgm.sql(`ALTER TABLE payments DROP CONSTRAINT payments_method_check`);
  pgm.addConstraint('payments', 'payments_method_check', {
    check: "method IN ('asaas_pix','asaas_card','cash','external','pix_manual')",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE payments DROP CONSTRAINT payments_method_check`);

  pgm.sql(`
    UPDATE payments SET method = replace(replace(method, 'asaas_pix', 'pix'), 'asaas_card', 'card')
    WHERE method IN ('asaas_pix','asaas_card')
  `);

  pgm.addConstraint('payments', 'payments_method_check', {
    check: "method IN ('pix','card')",
  });

  pgm.dropConstraint('payments', 'payments_kind_check');
  pgm.dropColumn('payments', 'kind');
}
