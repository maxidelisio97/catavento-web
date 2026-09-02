/**
 * GET /panel/cash/sale-items/report — SPEC-modulo-10-caja.md § 6 (entrega
 * 10B), the per-product report: units sold and total revenue per catalog
 * item within a period.
 *
 * A free-concept sale (cash_movements.sale_item_id IS NULL) is excluded
 * here by design (§ 6: "el concepto libre queda fuera del reporte por
 * producto — es ocasional") — its money still counts in the general
 * ledger's sale_income_cents (getCashLedger.ts), just not attributed to a
 * product line here.
 *
 * Sums cash_movements.amount_cents as stored on each sale — never
 * cash_sale_items.default_price_cents × quantity. The catalog's suggested
 * price is only a form default at sale time (re-editable, and possibly
 * changed again afterwards); the report must keep reflecting what each
 * past sale actually charged, not be silently reshaped by a later catalog
 * price edit. Same "precio congelado" principle as reservation pricing,
 * now applied to the AGGREGATE, not just the individual row.
 */
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/types.js';

export interface SaleItemReportEntry {
  sale_item_id: number;
  name: string;
  quantity_sold: number;
  total_cents: number;
}

export interface SaleItemReport {
  from: string;
  to: string;
  items: SaleItemReportEntry[];
}

export async function getSalesByItemReport(db: Kysely<DB>, input: { from: string; to: string }): Promise<SaleItemReport> {
  const { from, to } = input;

  const rows = await db
    .selectFrom('cash_movements as cm')
    .innerJoin('cash_sale_items as si', 'si.id', 'cm.sale_item_id')
    .select((eb) => [
      'cm.sale_item_id as sale_item_id',
      'si.name as name',
      eb.fn.sum<string>('cm.quantity').as('quantity_sold'),
      eb.fn.sum<string>('cm.amount_cents').as('total_cents'),
    ])
    .where('cm.deleted_at', 'is', null)
    .where('cm.kind', '=', 'income')
    .where('cm.sale_item_id', 'is not', null)
    .where('cm.occurred_on', '>=', sql<Date>`${from}::date`)
    .where('cm.occurred_on', '<=', sql<Date>`${to}::date`)
    .groupBy(['cm.sale_item_id', 'si.name'])
    .orderBy('total_cents', 'desc')
    .execute();

  return {
    from,
    to,
    items: rows.map((row) => ({
      sale_item_id: row.sale_item_id as number,
      name: row.name,
      quantity_sold: Number(row.quantity_sold),
      total_cents: Number(row.total_cents),
    })),
  };
}
