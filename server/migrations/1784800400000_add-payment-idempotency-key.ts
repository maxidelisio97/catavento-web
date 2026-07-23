import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// Risk-review finding on módulo 7B (server/CLAUDE.md): manual payments
// (cash/external/pix_manual, § 5.2 camino B) had zero duplicate-submission
// protection — unlike the Asaas path, which reuses/dedupes via
// createOrReuseAsaasPayment's advisory lock + kind lookup. A double-click or,
// more likely given the pousada's irregular connectivity, a network retry
// after a hung request, could register the same cash payment twice, inflating
// amount_paid_cents and letting check-out proceed with real money still owed
// — and nothing else (no Asaas statement, no webhook) would ever surface the
// mismatch.
//
// Same pattern as idx_payments_one_pending_per_reservation: the advisory lock
// in registerPayment (added alongside this migration) is what actually
// serializes concurrent requests and makes the dedupe lookup reliable; this
// constraint is the defense-in-depth net underneath it.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('payments', {
    idempotency_key: { type: 'text' },
  });

  pgm.createIndex('payments', ['reservation_id', 'idempotency_key'], {
    name: 'idx_payments_reservation_idempotency_key_unique',
    unique: true,
    where: 'idempotency_key IS NOT NULL',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('payments', ['reservation_id', 'idempotency_key'], {
    name: 'idx_payments_reservation_idempotency_key_unique',
    ifExists: true,
  });
  pgm.dropColumn('payments', 'idempotency_key');
}
