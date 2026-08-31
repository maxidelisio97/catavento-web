import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// SPEC-modulo-10-caja.md § 5.1 (entrega 10A) — the cash ledger's own tables
// (cash_movements, cash_expense_categories) plus one addition to `payments`
// itself: `received_at`.
//
// Why `payments.received_at` is needed at all (not in the original spec SQL,
// added during 10A discovery, approved 2026-08-30): `payments` has no
// column that means "the day this payment was actually received" — only
// `created_at` (set once, at insert) and `updated_at`, which
// `payments_set_updated_at` (see 1784587363421_add-payments-and-settings.ts)
// bumps on ANY update to the row, unconditionally, not just a status
// transition. Building the cash ledger's date filter on `updated_at` would
// be fragile: a future edit to an already-received payment would silently
// move it to a different day in the ledger. `received_at` is set exactly
// once, only by the code paths that transition a payment to `status =
// 'received'` — see the four call sites patched alongside this migration
// (src/availability/confirmPendingReservation.ts, which
// src/reservations/overpaymentGuard.ts's reconciliation also calls through;
// src/reservations/createOrReusePayment.ts; src/panel/reservationActions.ts;
// src/panel/createManualReservation.ts, two insert sites). Audited
// exhaustively (grep for every `updateTable('payments')` and
// `insertInto('payments')` in src/, excluding tests) before writing this —
// no other path ever sets status to 'received'.
//
// Backfill correctness: `received_at = updated_at` for existing received
// rows is exact, not approximate. The only UPDATE that ever touches a
// payments row a second time after it's already 'received' is the
// flagged_overpayment write in confirmPendingReservation.ts, and it runs in
// the same transaction, same instant, as the receive-update immediately
// before it — same calendar day, always. No admin/edit endpoint exists that
// could move updated_at away from the true receipt day.
//
// `cash_movements` intentionally does NOT include `sale_item_id`/`quantity`
// from the spec's § 2.1 SQL — that references `cash_sale_items`, which is
// 10B scope (§ 4: "10A — el modelo (cash_movements, cash_expense_categories)").
// Adding a nullable FK to a table that doesn't exist yet would be dead
// weight until 10B lands; those columns arrive with 10B's own migration.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('payments', {
    received_at: { type: 'timestamptz' },
  });

  pgm.sql(`UPDATE payments SET received_at = updated_at WHERE status = 'received'`);

  // Partial index: the ledger (§ 3) always filters `status = 'received'`
  // plus a date range on this column — per server/CLAUDE.md's
  // rendimiento-y-consultas rule, index the column this hot-table query
  // will actually filter on.
  pgm.createIndex('payments', 'received_at', {
    name: 'idx_payments_received_at',
    where: "status = 'received'",
  });

  pgm.createTable('cash_expense_categories', {
    id: 'id',
    name: { type: 'text', notNull: true },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('cash_expense_categories', 'cash_expense_categories_name_unique', { unique: ['name'] });

  pgm.createTable('cash_movements', {
    id: 'id',
    kind: { type: 'text', notNull: true },
    amount_cents: { type: 'integer', notNull: true, check: 'amount_cents > 0' },
    occurred_on: { type: 'date', notNull: true },
    description: { type: 'text' },
    expense_category_id: { type: 'integer', references: 'cash_expense_categories' },
    method: { type: 'text' },
    deleted_at: { type: 'timestamptz' },
    created_by: { type: 'integer', notNull: true, references: 'users' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('cash_movements', 'cash_movements_kind_check', {
    check: "kind IN ('income','expense')",
  });
  // expense_category_id only makes sense on an expense row — catches a
  // mis-wired insert at the DB level rather than silently mislabeling data.
  pgm.addConstraint('cash_movements', 'cash_movements_expense_category_kind_check', {
    check: "kind = 'expense' OR expense_category_id IS NULL",
  });

  // The ledger (§ 3, arrives in the next batch) filters/orders by
  // occurred_on within a period, on live (non-deleted) rows.
  pgm.createIndex('cash_movements', 'occurred_on', {
    name: 'idx_cash_movements_occurred_on',
    where: 'deleted_at IS NULL',
  });

  // Seed: § 7 permission catalog. Same pattern as M9's seed
  // (1784900000000_add-permissions-and-roles.ts) — permissions are data, the
  // Dueño role bypasses these automatically via is_owner (no role_permissions
  // row needed for it).
  pgm.sql(`
    INSERT INTO permissions (key, description) VALUES
      ('cash.view', 'Ver o livro de caixa e relatórios'),
      ('cash.income', 'Registrar receitas (vendas avulsas)'),
      ('cash.expense', 'Registrar despesas'),
      ('cash.manage', 'Gerenciar categorias de despesa e catálogo de vendas');
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DELETE FROM permissions WHERE key IN ('cash.view', 'cash.income', 'cash.expense', 'cash.manage');
  `);
  pgm.dropTable('cash_movements');
  pgm.dropTable('cash_expense_categories');
  pgm.dropIndex('payments', 'received_at', { name: 'idx_payments_received_at' });
  pgm.dropColumn('payments', 'received_at');
}
