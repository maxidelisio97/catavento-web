import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// sdd/asaas-pagarme-migration design (obs #257) — introduces a
// provider-agnostic `provider` + `provider_payment_id` pair on `payments`,
// additive only (D2 rollback requirement): `asaas_payment_id` is kept and
// dual-written while provider='asaas', so rolling back to Asaas needs no
// data migration, just an env var + restart.
//
// No DEFAULT on `provider`/`provider_payment_id` — a post-cutover default of
// 'asaas' would silently mislabel any row the app didn't explicitly write.
// Every INSERT going forward sets both columns explicitly.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('payments', {
    provider: { type: 'text', notNull: false },
    provider_payment_id: { type: 'text', notNull: false },
  });

  pgm.sql(`
    UPDATE payments
    SET provider = 'asaas', provider_payment_id = asaas_payment_id
    WHERE asaas_payment_id IS NOT NULL
  `);

  pgm.addConstraint('payments', 'payments_provider_check', {
    check: "provider IS NULL OR provider IN ('asaas','pagarme')",
  });

  // Pairing invariant: a payment has a provider identity or it doesn't —
  // never one column set without the other. NULL provider marks a manually
  // registered payment (cash/external/pix_manual), which has no provider.
  pgm.addConstraint('payments', 'payments_provider_pairing_check', {
    check: '(provider IS NULL) = (provider_payment_id IS NULL)',
  });

  // Partial UNIQUE (not a plain unique on provider_payment_id alone) so two
  // different providers could never collide on an id, and manually
  // registered payments (both columns NULL) don't pile up in a UNIQUE that
  // treats every NULL as distinct anyway — the WHERE clause makes that
  // explicit instead of relying on default NULL semantics. This is also the
  // index the /webhooks/pagarme lookup needs on every delivery (server/
  // CLAUDE.md "index what you query").
  pgm.createIndex('payments', ['provider', 'provider_payment_id'], {
    name: 'payments_provider_payment_id_unique',
    unique: true,
    where: 'provider_payment_id IS NOT NULL',
  });

  // Widen, never remove — mirrors 1784800000000's own comment. pagarme_pix/
  // pagarme_card follow the existing asaas_* method-literal convention.
  pgm.sql('ALTER TABLE payments DROP CONSTRAINT payments_method_check');
  pgm.addConstraint('payments', 'payments_method_check', {
    check: "method IN ('asaas_pix','asaas_card','pagarme_pix','pagarme_card','cash','external','pix_manual')",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Down is dev-only (production rollback is the flag, not the migration —
  // see design's Rollback section). Guard against silently dropping real
  // Pagar.me payment identities.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM payments WHERE provider = 'pagarme') THEN
        RAISE EXCEPTION 'Cannot roll back add-payment-provider-columns: payments.provider = ''pagarme'' rows exist';
      END IF;
    END $$;
  `);

  pgm.sql('ALTER TABLE payments DROP CONSTRAINT payments_method_check');
  pgm.addConstraint('payments', 'payments_method_check', {
    check: "method IN ('asaas_pix','asaas_card','cash','external','pix_manual')",
  });

  pgm.dropIndex('payments', ['provider', 'provider_payment_id'], {
    name: 'payments_provider_payment_id_unique',
  });
  pgm.dropConstraint('payments', 'payments_provider_pairing_check');
  pgm.dropConstraint('payments', 'payments_provider_check');
  pgm.dropColumn('payments', 'provider_payment_id');
  pgm.dropColumn('payments', 'provider');
}
