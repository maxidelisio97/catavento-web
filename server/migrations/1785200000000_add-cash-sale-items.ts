import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// SPEC-modulo-10-caja.md § 6 (entrega 10B) — the sale catalog
// (`cash_sale_items`) plus the two columns on `cash_movements` that 10A's
// migration deliberately left out (see 1785100000000's comment: adding a
// nullable FK to a table that didn't exist yet would've been dead weight).
//
// Hybrid sale, confirmed with Maxi before implementing: `sale_item_id` links
// a movement to the catalog for the per-product report; NULL means a free-
// concept sale (occasional, uses `description` like today). Both are
// `kind='income'` — no new kind, no new permission beyond the existing
// `cash.income`.
//
// Frozen price, same principle as reservation pricing (`el precio de una
// reserva se congela al crearla` — server/CLAUDE.md): `cash_movements.
// amount_cents` is what the sale actually charged, set once at insert. The
// per-product report (10B, next batch) sums THAT column, never
// `cash_sale_items.default_price_cents * quantity` — the catalog's
// suggested price is only a form default, re-editable at sale time, and
// changing it later must never reshape historical sales.
//
// No hard-delete for `cash_sale_items` (confirmed with Maxi): the CRUD only
// exposes `active`, same as `cash_expense_categories`. Deactivating an item
// removes it from the sell picker without breaking the `sale_item_id` FK on
// past movements — the report keeps showing sales made with an item that's
// since been deactivated, because it's history, not a live catalog lookup.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('cash_sale_items', {
    id: 'id',
    name: { type: 'text', notNull: true },
    default_price_cents: { type: 'integer', check: 'default_price_cents IS NULL OR default_price_cents > 0' },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('cash_sale_items', 'cash_sale_items_name_unique', { unique: ['name'] });

  pgm.addColumn('cash_movements', {
    sale_item_id: { type: 'integer', references: 'cash_sale_items' },
    quantity: { type: 'integer', check: 'quantity IS NULL OR quantity > 0' },
  });

  // A catalog sale always carries a quantity (needed for the per-product
  // report's units count); a free-concept sale never does. Catches a
  // mis-wired insert at the DB level, same reasoning as 10A's
  // cash_movements_expense_category_kind_check.
  pgm.addConstraint('cash_movements', 'cash_movements_sale_item_quantity_check', {
    check: '(sale_item_id IS NULL AND quantity IS NULL) OR (sale_item_id IS NOT NULL AND quantity IS NOT NULL)',
  });

  // Symmetric with cash_movements_expense_category_kind_check above: a sale
  // (sale_item_id) only makes sense on an income row. Without this, a PATCH
  // could attach a catalog item to an expense row (nothing else stops it —
  // PATCH's body has no `kind` field to check against at the Zod layer).
  pgm.addConstraint('cash_movements', 'cash_movements_sale_item_kind_check', {
    check: "kind = 'income' OR sale_item_id IS NULL",
  });

  // The per-product report (10B, next batch) groups by sale_item_id within
  // a date range on live (non-deleted) rows — same filter shape as
  // idx_cash_movements_occurred_on from 10A.
  pgm.createIndex('cash_movements', 'sale_item_id', {
    name: 'idx_cash_movements_sale_item_id',
    where: 'deleted_at IS NULL AND sale_item_id IS NOT NULL',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('cash_movements', 'sale_item_id', { name: 'idx_cash_movements_sale_item_id' });
  pgm.dropConstraint('cash_movements', 'cash_movements_sale_item_kind_check');
  pgm.dropConstraint('cash_movements', 'cash_movements_sale_item_quantity_check');
  pgm.dropColumn('cash_movements', 'quantity');
  pgm.dropColumn('cash_movements', 'sale_item_id');
  pgm.dropTable('cash_sale_items');
}
