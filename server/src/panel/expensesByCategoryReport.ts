/**
 * GET /panel/cash/expense-categories/report — SPEC-modulo-10-caja.md § 6
 * (entrega 10C), expenses grouped by category within a period.
 *
 * LEFT JOIN, not INNER: an expense with no `expense_category_id` (allowed —
 * the column is nullable) is still money that went out. Dropping it here
 * would make this report's total diverge from the ledger's `expense_cents`
 * (getCashLedger.ts), which counts every `kind='expense'` row regardless of
 * category. Uncategorized expenses are grouped under `category_id: null`,
 * `name: 'Sem categoria'`.
 *
 * Sums `cash_movements.amount_cents` directly — no other table to freeze
 * against here (unlike the per-product report, an expense has no catalog
 * default price that could drift).
 */
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';

export interface ExpenseCategoryReportEntry {
  category_id: number | null;
  name: string;
  total_cents: number;
}

export interface ExpenseCategoryReport {
  from: string;
  to: string;
  categories: ExpenseCategoryReportEntry[];
}

export async function getExpensesByCategoryReport(
  db: Kysely<DB>,
  input: { from: string; to: string },
): Promise<ExpenseCategoryReport> {
  const { from, to } = input;

  const rows = await db
    .selectFrom('cash_movements as cm')
    .leftJoin('cash_expense_categories as cat', 'cat.id', 'cm.expense_category_id')
    .select((eb) => [
      'cm.expense_category_id as category_id',
      eb.fn.coalesce('cat.name', sql<string>`'Sem categoria'`).as('name'),
      eb.fn.sum<string>('cm.amount_cents').as('total_cents'),
    ])
    .where('cm.deleted_at', 'is', null)
    .where('cm.kind', '=', 'expense')
    .where('cm.occurred_on', '>=', sql<Date>`${from}::date`)
    .where('cm.occurred_on', '<=', sql<Date>`${to}::date`)
    .groupBy(['cm.expense_category_id', 'cat.name'])
    .orderBy('total_cents', 'desc')
    .execute();

  return {
    from,
    to,
    categories: rows.map((row) => ({
      category_id: row.category_id as number | null,
      name: row.name,
      total_cents: Number(row.total_cents),
    })),
  };
}
